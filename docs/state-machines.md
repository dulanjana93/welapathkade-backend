# Welapathkade — State Machines

This document defines the authoritative V1 state transitions.

Invalid state transitions must be rejected by the backend.

---

# 1. Consultation Request

Initial state:

```text
PENDING
```

State machine:

```text
PENDING
 ├── ACCEPT   → ACCEPTED
 ├── DECLINE  → DECLINED
 ├── TIMEOUT  → EXPIRED
 └── CUSTOMER_CANCEL → CANCELLED
```

Rules:

- ACCEPT is only allowed while PENDING and `expiresAt > now`.
- DECLINE is only allowed while PENDING and `expiresAt > now`.
- Timeout is only allowed while PENDING and `expiresAt <= now`.
- Customer cancellation is only allowed while PENDING.
- `viewedAt` does not affect expiry.
- If accept/decline is attempted after expiry, transition PENDING → EXPIRED (idempotent) and reject the action.
- Once ACCEPTED, DECLINED, EXPIRED, or CANCELLED, the request cannot return to PENDING or be accepted/declined again.

Terminal states (request lifecycle):

```text
DECLINED
EXPIRED
CANCELLED
```

ACCEPTED is not terminal for the overall consultation journey because appointment scheduling follows (Phase 5), but it is terminal for Phase 4 request actions (accept/decline/cancel).

**Meaning of Consultation ACCEPTED:** the assigned astrologer accepted the consultation *request* (willingness to proceed). It does **not** mean a time is booked, payment succeeded, or an appointment is confirmed.

Authorization:

- PUBLIC: create; list/view own; cancel own PENDING.
- ASTROLOGER: list/view assigned; accept/decline assigned PENDING.
- Every query is ownership-scoped (never trust client IDs alone).

---

# 2. Appointment Proposal (Phase 5A)

Model: `ConsultationProposal`

A proposal is **not** a booking, reservation, or payment. It is a concrete date/time + duration offered by the astrologer after the consultation request is ACCEPTED.

Initial state:

```text
PENDING
```

State machine:

```text
PENDING
 ├── CUSTOMER_ACCEPT → ACCEPTED
 ├── CUSTOMER_REJECT → REJECTED
 └── SUPERSEDE       → SUPERSEDED
```

Statuses:

```text
PENDING     — awaiting customer response
ACCEPTED    — customer accepted this proposed time (scheduling only)
REJECTED    — customer rejected; astrologer may create another proposal
SUPERSEDED  — another proposal on the same consultation was accepted
```

Rules:

- Only the assigned ASTROLOGER may create a proposal.
- Consultation must be `status = ACCEPTED`.
- Only one `PENDING` proposal may exist per consultation at a time.
- Creating a proposal while another is `PENDING` is rejected.
- Creating a proposal after one is already `ACCEPTED` is rejected.
- Historical proposals are never deleted.
- Customer ACCEPT / REJECT only while proposal is `PENDING`.
- On ACCEPT: proposal `PENDING → ACCEPTED`; any other `PENDING` proposals for the same consultation become `SUPERSEDED` atomically.
- Only one proposal may ultimately be `ACCEPTED` per consultation.
- Consultation.status remains `ACCEPTED` after proposal acceptance (not overloaded to “CONFIRMED”).
- No payment, reservation row, PayHere, or confirmed appointment in Phase 5A.

**Meaning of Proposal ACCEPTED:** the customer accepted the proposed appointment time. It does **not** mean payment has succeeded. Payment/reservation belongs to Phase 5B+.

Scheduling validation (reuse AvailabilityService / AvailabilityCalculator):

- At least 1 hour lead time from now.
- At most 30 days into the future.
- Start and end must fit inside the same valid availability interval.
- Respect weekly windows (Asia/Colombo clock) and exceptions.
- Duration is chosen by the astrologer (15–240 minutes — same bounds as slot enumeration).
- `proposedEndAt` is derived server-side: `proposedStartAt + durationMinutes`.
- Database stores UTC; weekly availability uses Colombo local time.

Authorization:

- ASTROLOGER: create/list proposals for assigned consultations.
- PUBLIC customer: list/accept/reject proposals for own consultations.

Terminal states:

```text
ACCEPTED
REJECTED
SUPERSEDED
```

Note (Phase 5A scope): proposal `EXPIRED` / `CANCELLED` transitions from the long-term product docs are **not** implemented in Phase 5A. `SUPERSEDED` covers the concurrent-accept safety case.

---

# 3. Appointment

Appointment lifecycle is independent of the payment gateway's `PaymentStatus`.
Implemented by `src/payments/appointment.state.ts` (table),
`src/payments/appointment-lifecycle.service.ts` (guarded transitions) and
`src/payments/session-events.ts` (verified-event contracts).

## 3.1 Transition table

| Transition | From | To | Initiator | Notes |
|---|---|---|---|---|
| PAYMENT_SUCCESS | PAYMENT_PENDING | CONFIRMED | Verified payment (server-side) | Phase 5B, unchanged |
| PAYMENT_TIMEOUT | PAYMENT_PENDING | PAYMENT_EXPIRED | Reservation expiry | Phase 5B, unchanged |
| SESSION_START | CONFIRMED | IN_PROGRESS | Verified session event (internal) | Event must fall in the join window |
| SESSION_END | IN_PROGRESS | COMPLETED | Verified session event (internal) | Duration derived server-side |
| CUSTOMER_CANCEL | CONFIRMED | CANCELLED_BY_CUSTOMER | The appointment's customer | `POST /consultations/:consultationId/appointment/cancel` |
| ASTROLOGER_CANCEL | CONFIRMED | CANCELLED_BY_ASTROLOGER | The appointment's astrologer | `POST /astrologers/me/consultations/:consultationId/appointment/cancel` |
| CUSTOMER_NO_SHOW | CONFIRMED | NO_SHOW_CUSTOMER | Verified attendance report (internal) | Manual review required |
| ASTROLOGER_NO_SHOW | CONFIRMED | NO_SHOW_ASTROLOGER | Verified attendance report (internal) | Refund obligation + incident |
| BOTH_NO_SHOW | CONFIRMED | NO_SHOW_BOTH | Verified attendance report (internal) | Refund obligation |

Every other (status, transition) pair is rejected (409). Terminal in this phase:
PAYMENT_EXPIRED, COMPLETED, CANCELLED_BY_*, NO_SHOW_*. The legacy `CANCELLED`
value is never written. `NO_SHOW_CUSTOMER` can only be resolved by a future
admin review (not implemented). `DISPUTED` and `TECHNICAL_FAILURE` are
reserved for the dispute phase and are NOT implemented.

Cancellation applies to CONFIRMED only. Cancelling a PAYMENT_PENDING hold is
unchanged (it expires after 30 minutes).

### 3.1.1 Cancellation timing (Phase B1)

Ordinary cancellation by either party is allowed only **strictly before the
scheduled start** (`isCancellationAllowedAt`, evaluated under the astrologer lock
with a fresh clock reading):

| Moment (S = scheduled start) | Cancellation |
|---|---|
| now < S − 10 min (before the join window) | allowed |
| S − 10 min ≤ now < S (join window open, not started) | allowed — the customer keeps the 100% refund entitlement ("even 5 minutes before") |
| S ≤ now ≤ S + 10 min (late-grace period) | rejected, 409 |
| now > S + 10 min (after grace) | rejected, 409 |
| `IN_PROGRESS` or any terminal state | rejected by the state machine (409) |

A rejected cancellation is checked before any write: no appointment change, no
refund obligation, no consultation closure, no reliability incident. Repeating a
cancellation that already succeeded stays idempotent (no new writes), even after
the start. Elapsed time is never treated as absence: a CONFIRMED appointment
whose start has passed stays CONFIRMED until trusted session/attendance evidence
produces `IN_PROGRESS` or a no-show outcome. `actionability.canCancelAppointment`
follows the same rule (false from S onwards, fails closed without a start time).

Open policy question: until attendance evidence and a no-show job exist, a missed
appointment cannot be cancelled and has no automatic resolution path.

## 3.2 Outcomes recorded on `Appointment`

| Outcome | Refund obligation | Reliability incident | Manual review | Earnings / referral |
|---|---|---|---|---|
| Customer cancel | `FULL_REFUND_DUE` | none | no | none |
| Astrologer cancel | `FULL_REFUND_DUE` | `CANCELLATION` | no | none |
| Customer no-show | none | none | `manualReviewRequired = true` | none until reviewed |
| Astrologer no-show | `FULL_REFUND_DUE` | `NO_SHOW` | no | none |
| Both absent | `FULL_REFUND_DUE` | none (see open decisions) | no | none |
| Completed | none | none | no | not created in this phase |

`refundObligation` records that the customer is OWED a refund. It does not mean
money was refunded. `PayHereRefund` is the gateway attempt and is created after
the appointment lock commits. A ledger reversal is a third, separate record.

Reliability incidents live in `AstrologerReliabilityIncident`
(unique per appointment + type, so repeats cannot duplicate them).

## 3.3 Verified session events (provider integration point)

No video provider is selected. Nothing produces verified events in production
and no HTTP route accepts them.

### 3.3.1 Trust boundary (Phase B3-a / B3-a.1)

Runtime trust is a process-local `SessionEvidenceCapability` (WeakSet-backed)
from `src/session-evidence`. A TypeScript cast of a plain object is rejected.
There is **no** general-purpose mint, register, or unlock export for production
modules. `ProviderAdapterBoundary` authentication **fails closed** until a real
authenticator is registered (`isSessionEvidenceProviderAuthImplemented() === false`),
so no production capability is issued today.

Test-only minting lives entirely under `test/support/` and is wired through
Jest module replacement (unit + e2e setup). Production `capability.ts` has no
mint API and ships no Jest-only helpers in `dist`.

`AppointmentLifecycleService.recordSessionStart` / `recordSessionEnd` /
`recordNoShow` require that capability as their first argument. There is no
generally importable `mark*Verified` helper.

Join/leave **facts** are persisted by `SessionEvidenceService` into
`SessionAttendanceEvidence` (unique on `provider + providerEventId`).
`appointmentId` is resolved only via `RoomAppointmentMappingResolver` (fail-closed
with zero mappings until a provider integration exists). Exact duplicate replays
are idempotent; the same event id with conflicting immutable fields is a 409.
`receivedAt` is not part of the duplicate identity. Inserting evidence never
changes appointment status, refunds, manual-review flags, or reliability
incidents, and never calls lifecycle session-start / end / no-show. Delayed
events for already-mapped appointments are **retained** for investigation.

**Persistence E2E prerequisite (test DB only, not run by this remediation):**
apply migration `20261010140000_phase_b3a_session_attendance_evidence` to
`welapathkade_test`, e.g. `npm run test:e2e:migrate` (uses the e2e env loader).
Without that table the persistence case fails loudly rather than silently passing.

Required before production acceptance of trusted evidence: a provider adapter
that authenticates callbacks, maps room→appointment and participant→role inside
`ProviderAdapterBoundary`, then records normalized events without exposing a
public mint API.

### 3.3.2 Lifecycle session transitions (unchanged rules)

- Start: appointment CONFIRMED and event time within the join window.
  Stores `sessionStartedAt` and the unique `sessionStartEventId`.
- End: appointment IN_PROGRESS and event time >= `sessionStartedAt`. Stores
  `sessionEndedAt`, `actualDurationSeconds` (derived, never client-supplied),
  the unique `sessionEndEventId`, and sets `Consultation.completedAt`. No
  minimum duration. Completion is never inferred from the scheduled duration
  elapsing for a never-started appointment.
- Idempotency: replaying the same event id returns the current state; a
  different event for an already-started/completed appointment is a 409; an
  event id can apply to only one appointment (unique columns).
- No audio/video is recorded.

### 3.3.3 Trusted production triggers (Phase 1 session completion)

Until a media-provider adapter authenticates Agora (or equivalent) webhooks,
two **server-only** paths mint `INTERNAL_LIFECYCLE` capabilities and call the
existing lifecycle methods. Clients never POST start/end/complete and cannot
supply timestamps or durations.

| Transition | Trusted trigger | Event id |
|---|---|---|
| SESSION_START | First authorized `VideoSessionService.issueCredentialsForConsultation` while status is `CONFIRMED` and inside the join window | `internal:video-join:{appointmentId}` |
| SESSION_END | `SessionCompletionSweepService` (via the expiry sweeper) when status is `IN_PROGRESS`, `sessionStartedAt` is set, and `now > endAt + VIDEO_SESSION_END_BUFFER_MINUTES` | `internal:session-hard-end:{appointmentId}` |

Rules:

- Leaving the Agora channel does **not** complete or cancel the appointment.
- A never-started `CONFIRMED` appointment whose scheduled end has passed is
  **not** marked `COMPLETED`. No-show still requires verified attendance
  (unchanged); the sweep does not invent no-shows.
- After `COMPLETED`, video credential issuance is rejected for both roles
  (`isVideoJoinableStatus` / `canJoinVideoSession`).
- Slot occupancy releases when status enters `SLOT_RELEASED_STATUSES`
  (including `COMPLETED`), unchanged.

## 3.4 Join window and no-show conditions

Agreed policy: earliest join 10 minutes before the scheduled start, late
arrival grace 10 minutes after it. Constants:
`JOIN_WINDOW_BEFORE_START_MINUTES`, `JOIN_GRACE_AFTER_START_MINUTES`.

This phase encodes the policy in the state-machine helpers only. It is NOT
enforced end to end: there is no call provider, no join endpoint and no
scheduler. A no-show may be recorded only when (a) the appointment is
CONFIRMED, (b) the server clock is strictly past start + 10 minutes, and (c) a
verified attendance report (from the future provider) states who joined. Both
joined is rejected. Neither a timer alone nor a client assertion can produce a
no-show.

## 3.5 Concurrency

Every transition runs inside `BookingGuardService.withAstrologerLock`, re-reads
the appointment under the lock, and updates with a status guard
(`WHERE id AND status = <expected>`), so competing transitions cannot both win.
Cancelled, no-show and completed appointments release the astrologer's
calendar slot (`SLOT_RELEASED_STATUSES`); IN_PROGRESS blocks it. Checkout can
never revive an appointment in any lifecycle status
(`CHECKOUT_BLOCKED_STATUSES`).

## 3.5.1 Automated expiry (Phase B2)

Two deadlines are enforced both on read (unchanged) and by a background sweeper:

| Record | Deadline | Rule (single definition) |
|---|---|---|
| Payment hold | 30 min (`reservationExpiresAt`) | `PAYMENT_PENDING` and `reservationExpiresAt <= now` → `PAYMENT_EXPIRED`; then its `PENDING` payment and attempts → `EXPIRED` (`OccupancyService.expireDueReservations`, `expireOrphanedPendingPayments`) |
| Consultation request | 12 h (`expiresAt`) | `PENDING` and `expiresAt <= now` → `EXPIRED` (`expirePendingConsultations`) |

The boundary is inclusive for expiry (`<=`), so accept/decline/confirm, which require
`> now`, are exactly complementary and serialize on the row.

An expired payment hold does NOT release the slot and does not touch the accepted
proposal: the proposal keeps blocking the slot and the customer may retry checkout
for the same proposal (a new hold and attempt are created). Paid (`CONFIRMED`)
appointments are never expired. Expiry never implies a no-show, creates no
notification and no refund.

**Sweeper** (`src/expiry`): a dependency-free timer in the API process.
- `EXPIRY_SWEEP_ENABLED` (`true`/`false`): default on, except `NODE_ENV=test` (off).
- `EXPIRY_SWEEP_INTERVAL_SECONDS` (5-3600): default 60.
- One run at start-up, then every interval; never overlaps itself in a process; the
  timer is `unref`ed and cleared on shutdown (`enableShutdownHooks`), which also
  waits for a run in flight.
- Failures are logged and retried on the next tick. Each step is an idempotent,
  status-guarded UPDATE, so several instances (or overlapping runs) are safe; the
  payment-recovery step also repairs a run that flipped a hold and failed before
  expiring its payment.

## 3.6 Consultation closure (Phase 1A)

The consultation must never look actionable once its appointment is terminal.
`AppointmentLifecycleService.closeConsultation` updates the linked
`Consultation` in the SAME transaction (and astrologer lock) as the
appointment transition:

| Appointment outcome | Consultation status | `completedAt` |
|---|---|---|
| COMPLETED | COMPLETED | set (verified session end) |
| CANCELLED_BY_CUSTOMER / CANCELLED_BY_ASTROLOGER | CANCELLED | null |
| NO_SHOW_CUSTOMER / NO_SHOW_ASTROLOGER / NO_SHOW_BOTH | CANCELLED | null |

- `CANCELLED` means "closed without a held session". It is not a claim about who
  cancelled: the appointment status remains authoritative for the exact reason
  (who cancelled, which participant was absent, `manualReviewRequired`).
- `COMPLETED` is the only new consultation status; a completion cannot be
  represented by any existing value.
- Only an `ACCEPTED` consultation is closed (`WHERE status = ACCEPTED`). Any
  other state is a 409 and rolls back the appointment transition; nothing is
  overwritten silently.
- Repeated events return early (idempotent) and never touch the consultation.
- Refund obligations, payments, ledgers and referrals are untouched.
- Consultation transitions: `ACCEPTED → CANCELLED` (APPOINTMENT_CLOSED) and
  `ACCEPTED → COMPLETED` (APPOINTMENT_COMPLETED), see `consultation.state.ts`.
- Rows closed by Phase 1 code before this change (appointment terminal,
  consultation still ACCEPTED) are NOT backfilled here. The API still reports
  them correctly (the stage follows the appointment and `canCheckout` is false).

### Actionability in API responses

Consultation detail responses (customer `GET /consultations/:id`, astrologer
`GET /astrologers/me/consultations/:id`) include `actionability`, derived by
`deriveConsultationActionability` (`consultation.actionability.ts`):

```
actionability: {
  stage: REQUEST_PENDING | REQUEST_DECLINED | REQUEST_EXPIRED | REQUEST_CANCELLED
       | AWAITING_PROPOSAL | PROPOSAL_AWAITING_CUSTOMER | AWAITING_PAYMENT
       | CONFIRMED | IN_PROGRESS | COMPLETED
       | CANCELLED_BY_CUSTOMER | CANCELLED_BY_ASTROLOGER
       | NO_SHOW_CUSTOMER | NO_SHOW_ASTROLOGER | NO_SHOW_BOTH,
  isClosed, canCancelRequest, canRespondToRequest, canPropose,
  canRespondToProposal, canCheckout, canCancelAppointment
}
```

A terminal appointment always yields `canCheckout: false`. No existing field was
removed or renamed. The existing `appointment` object already carries the exact
lifecycle status and the customer-no-show `manualReviewRequired` flag; internal
session-event ids and attendance evidence are never exposed.

### Client work still required (Flutter, not done here)

- `ConsultationStatus.fromApi` falls back to `pending` for unknown values, so a
  `COMPLETED` consultation would render as pending until `completed` is added.
  (No production path can complete a consultation yet: no call provider.)
- `ConsultationDetailScreen` (user app) shows Confirm & Pay whenever the
  consultation is ACCEPTED without a confirmed appointment; it should use
  `actionability.canCheckout` (and `canCancelRequest`, `canRespondToProposal`).
- The astrologer app should use `canRespondToRequest` / `canPropose`.
- Add labels for the new stages (cancelled by whom, no-show who, review pending,
  completed, in progress).


4. Payment

Initial:

PENDING

State machine:

PENDING
 ├── SUCCESS → SUCCESS
 └── FAILURE → FAILED

Refund:

SUCCESS
 └── REFUND_REQUESTED → REFUND_PENDING

Then:

REFUND_PENDING
 ├── REFUND_SUCCESS → REFUNDED
 └── REFUND_FAILURE → FAILED

Payment webhook handling must be idempotent.

## 4.1 Callback ordering and integrity (Phase A1)

Verified gateway results are applied by `PaymentsService.finalizeVerified`:

| Sequence | Result |
|---|---|
| Success | Requires the gateway's own `amount` and `currency` (exact decimal match with the reservation). Missing/mismatching values change nothing / fail the attempt. Appointment `CONFIRMED` and payment `PAID` are written in one transaction; if the payment cannot move to `PAID` the confirmation is rolled back. |
| Failure | Fails only the attempt (if `PENDING`) and fails the payment once no attempt is pending, in one transaction. The appointment is untouched. Repeats are no-ops. |
| Failure → success | The verified success is authoritative: a `FAILED` attempt/payment becomes `PAID` together with the confirmation, while the reservation hold is live. |
| Success → failure | `PAID` is terminal. The late failure returns `alreadyPaid` and changes nothing. |
| Success after hold expiry | Payment is marked paid, the appointment stays unconfirmed, `FULL_REFUND_DUE` is set, and a full PayHere refund is requested. The appointment is never confirmed. |

Invariant: an appointment is `CONFIRMED` only together with a `PAID` payment.

Development-only integrations fail closed. `MockPaymentGateway`, `ConsoleSmsSender`,
`ConsoleFcmProvider`, mock payment callbacks and Swagger are allowed only when
`NODE_ENV` is exactly `development` or `test`; `NODE_ENV` is required (no default),
and an unset/unknown value is treated as production. Outside development/test,
`CORS_ORIGINS` must be set explicitly (no wildcards, no localhost).
Astrologer-facing responses never include payment attempts or merchant references.

5. Refund

Initial:

PENDING

State machine:

PENDING
 └── START_PROCESSING → PROCESSING

Then:

PROCESSING
 ├── SUCCESS → SUCCESS
 └── FAILURE → FAILED

A successful refund must create the corresponding financial reversal/adjustment.

6. Dispute

Initial:

OPEN

State machine:

OPEN
 └── START_REVIEW → UNDER_REVIEW

Then:

UNDER_REVIEW
 ├── RESOLVE → RESOLVED
 └── REJECT  → REJECTED

Resolution options:

FULL_REFUND
PARTIAL_REFUND
NO_REFUND
RESCHEDULE
DISMISSED

Every Admin resolution must be auditable.

7. Ledger Transaction

Initial earning state:

PENDING

Then:

PENDING
 ├── SETTLEMENT_REACHED → AVAILABLE
 ├── RESERVE             → RESERVED
 └── REVERSE             → REVERSED

Available:

AVAILABLE
 ├── RESERVE  → RESERVED
 └── REVERSE  → REVERSED

Reserved:

RESERVED
 ├── PAYOUT_SUCCESS → final consumed/settled
 ├── PAYOUT_FAILED  → AVAILABLE
 └── REVERSE        → REVERSED

The exact implementation may use transaction status and separate payout records, but historical ledger transactions must remain auditable.

8. Payout

Initial:

PENDING

State machine:

PENDING
 └── START → PROCESSING

Then:

PROCESSING
 ├── SUCCESS → SUCCESS
 └── FAILURE → FAILED

If payout fails:

reserved ledger amount
        ↓
available again

No money may disappear because of a failed payout.

9. Call Session

Recommended states:

CREATED
WAITING
IN_PROGRESS
ENDED
FAILED

Flow:

CREATED
   ↓
WAITING
   ↓
IN_PROGRESS
   ↓
ENDED

Technical failure:

CREATED / WAITING / IN_PROGRESS
        ↓
      FAILED

A failed video session may be followed by in-app audio if supported by the selected CallProvider.

V1 does not automatically record media.

10. Conversation

Initial:

ACTIVE

After 48 hours:

ACTIVE → READ_ONLY

Rules:

Customer may send maximum 5 messages.
Astrologer may send unlimited replies.
After READ_ONLY, no new messages can be created.
11. Review

Initial:

ACTIVE

Review can be edited for:

24 hours

After the edit window:

LOCKED

Astrologer may respond once.

Review reporting is separate from the review lifecycle.

12. Astrologer Status

Possible:

ACTIVE
INACTIVE
SUSPENDED

Suggested transitions:

INACTIVE → ACTIVE
ACTIVE   → INACTIVE
ACTIVE   → SUSPENDED
INACTIVE → SUSPENDED
SUSPENDED → ACTIVE

Suspension is Admin controlled.

12b. Astrologer Application Status

Possible:

DRAFT
PENDING_REVIEW
REJECTED
APPROVED

Transitions:

DRAFT → PENDING_REVIEW
REJECTED → PENDING_REVIEW
PENDING_REVIEW → APPROVED
PENDING_REVIEW → REJECTED

Approval also sets AstrologerProfile.status = ACTIVE.
Rejection keeps AstrologerProfile.status = INACTIVE.
Admin operational suspension uses AstrologerProfile.status and is separate from application review.

Submit (DRAFT/REJECTED → PENDING_REVIEW) and admin APPROVE both require onboarding readiness:

- required profile fields
- at least one active priced service within catalog bounds
- at least one weekly availability window

Failed APPROVE must leave application status unchanged (still PENDING_REVIEW).

Existing PENDING_REVIEW / APPROVED applications are not automatically moved backwards when availability rules are enforced; validation applies at transition time.

13. User Status

Possible:

ACTIVE
INACTIVE
SUSPENDED

Admin may suspend/restrict accounts according to platform rules.

14. Payment-Pending Reservation Expiry

When:

reservationExpiresAt <= now

and appointment is:

PAYMENT_PENDING

transition:

PAYMENT_PENDING → PAYMENT_EXPIRED

This transition must be idempotent.

Availability calculations must also ignore expired reservations even if the background job has not yet updated the row.

15. Consultation Request Expiry

When:

expiresAt <= now

and:

status = PENDING

transition:

PENDING → EXPIRED

Never expire an already accepted/declined/cancelled request.

16. Proposal Expiry

Long-term product rule (Phase 5B+ / workers — **not implemented in Phase 5A**):

When:

expiresAt <= now

and:

status = PENDING

transition:

PENDING → EXPIRED

Do not expire a proposal after it has already been accepted/rejected/superseded.

Phase 5A proposal statuses are PENDING / ACCEPTED / REJECTED / SUPERSEDED only (no EXPIRED/CANCELLED yet).

17. Idempotency Rule

Every asynchronous state transition must be safe to run multiple times.

Example:

Worker A:
PENDING → EXPIRED

Worker B:
PENDING → EXPIRED

Only one transition may actually occur.

Database state and conditional updates must protect against duplicate execution.

18. Transaction Rule

State transitions that affect financial or booking integrity must occur inside appropriate database transactions.

Especially:

proposal creation
proposal acceptance
appointment creation
payment finalization
refund creation
ledger creation
payout reservation
19. Booking Lock Rule

All operations that can reserve an astrologer's time must lock:

AstrologerBookingGuard

using:

SELECT astrologer_id
FROM astrologer_booking_guards
WHERE astrologer_id = ?
FOR UPDATE;

The lock must remain held until the transaction commits.

This prevents concurrent requests from both reserving overlapping time.

20. Invalid Transition Examples

These must be rejected:

DECLINED → ACCEPTED
EXPIRED → ACCEPTED
COMPLETED → CONFIRMED
PAYMENT_EXPIRED → PAYMENT_SUCCESS
CANCELLED_BY_CUSTOMER → IN_PROGRESS
REFUNDED → SUCCESS
SUCCESS PAYOUT → PROCESSING
READ_ONLY conversation → new message

Unless a specific Admin correction workflow explicitly supports an operation, normal business APIs must not bypass the state machine.

## 21. Saved card and automatic-payment consent

This is not a consultation payment state.

| From | Event | To |
|---|---|---|
| none | Customer accepts the current consent and pre-approval starts | `PENDING`, `CONSENT_GRANTED` |
| `PENDING` | Verified PayHere status `2` with `customer_token` | `ACTIVE`, authorization on, token encrypted |
| `PENDING` | Verified status `0`, or success without a token | stays `PENDING` |
| `PENDING` | Verified status `-1` or `-2` | `FAILED`, no token |
| `PENDING` or `ACTIVE` | Customer revokes authorization | `DISABLED`, token deleted, `CONSENT_REVOKED` |
| any except `REMOVED` | Customer removes the card | `REMOVED`, token deleted, authorization off, `CARD_REMOVED` |
| `DISABLED`, `REMOVED`, or `FAILED` | Another pre-approval notification | unchanged |

`DISABLED` and `REMOVED` cannot return to `ACTIVE`. A replacement card is a new row and needs a new `CONSENT_GRANTED`. The browser return URL is not a transition. Local revocation does not call a PayHere cancellation API. PayHere documents merchant-account cancellation only.

## 22. Saved-card consultation charge

This is a payment attempt. It does not start when the customer accepts a proposal. The customer must call `POST .../checkout/saved-card` with `confirmSavedCardPayment: true`. Manual checkout is unchanged.

| From | Event | To |
|---|---|---|
| no open `sc_` attempt | Customer confirms the saved-card payment | `PENDING` attempt, `openChargeSlot` set, then one Charging API call |
| `PENDING` and the request was not sent | Rate limit, OAuth failure, or revocation wins the dispatch lock | `FAILED`, slot cleared. A later explicit request may charge |
| `PENDING` | Retrieval finds one matching `RECEIVED` payment while the 30-minute hold is live | `PAID`, appointment `CONFIRMED`, slot cleared |
| `PENDING` | Retrieval finds one matching `RECEIVED` payment after the hold expired | `PAID`, appointment not confirmed, `FULL_REFUND_DUE`, existing refund flow, slot cleared |
| `PENDING` | Charging response of any status, including HTTP 200, status `2`, or a checkout-formula `md5sig` | not final by itself. Retrieval must confirm it |
| `PENDING` | Retrieval is empty, unavailable, mismatched, chargebacked, or has more than one `RECEIVED` row | stays `PENDING`, `requiresReview`, slot kept. No second charge |
| `requiresReview` | Retrieval finds one matching `RECEIVED` payment | same as a verified capture |
| `requiresReview` | Retrieval is empty, pending, mismatched, or has more than one match | stays `requiresReview` |

A synchronous Charging API response is not proof of payment. PayHere Retrieval must return exactly one `RECEIVED` row for that order id, amount, and currency. A payment id on the synchronous response is checked against that row and is not proof by itself. Checkout notifications still use their own documented `md5sig`.

Dispatch authorization is a `checkoutPayload.dispatchAuthorizedAt` value written in the same transaction as `SELECT … FOR UPDATE` on the saved card, after OAuth and before the charge POST. That transaction closes before the HTTP request. If revocation commits first, the POST is not sent. If dispatch authorization commits first, the charge is in flight: a later revocation deletes the token for future charges and does not cancel the request at PayHere or mark that attempt failed.

Revoking or removing the card after the charge request was sent does not mark that attempt canceled. A new card registration requires a new consent before another charge. A delayed pre-approval notification cannot make a `DISABLED` or `REMOVED` card `ACTIVE` again.
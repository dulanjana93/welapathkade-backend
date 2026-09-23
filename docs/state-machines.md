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

Initial state after customer accepts proposal (Phase 5B+ — not implemented in 5A):

PAYMENT_PENDING

State machine:

PAYMENT_PENDING
 ├── PAYMENT_SUCCESS    → CONFIRMED
 ├── PAYMENT_TIMEOUT    → PAYMENT_EXPIRED
 └── CUSTOMER_CANCEL    → CANCELLED_BY_CUSTOMER

Then:

CONFIRMED
 ├── SESSION_START      → IN_PROGRESS
 ├── CUSTOMER_CANCEL    → CANCELLED_BY_CUSTOMER
 ├── ASTROLOGER_CANCEL  → CANCELLED_BY_ASTROLOGER
 ├── CUSTOMER_NO_SHOW   → NO_SHOW_CUSTOMER
 ├── ASTROLOGER_NO_SHOW → NO_SHOW_ASTROLOGER
 └── TECHNICAL_FAILURE  → TECHNICAL_FAILURE

Then:

IN_PROGRESS
 └── SESSION_END → COMPLETED

A completed consultation may later become:

DISPUTED

when a valid dispute is opened.

Possible terminal/exception states:

PAYMENT_EXPIRED
CANCELLED_BY_CUSTOMER
CANCELLED_BY_ASTROLOGER
NO_SHOW_CUSTOMER
NO_SHOW_ASTROLOGER
TECHNICAL_FAILURE
COMPLETED

DISPUTED is an exception state requiring Admin resolution.

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
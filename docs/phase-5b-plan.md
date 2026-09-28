# Phase 5B Implementation Plan — Reservation + Payment + Confirmed Appointment

**Status:** Implemented (Phase 5B). Planning document retained as the source of approved decisions D1–D12.

**Inspection date:** 2026-09-23

**Scope of inspection:** `welapathkade-api`, `welapathkade_app`, `welapathkade-admin` as they exist after Phase 5A.

Legend used throughout:

- **CURRENT** — what the repository actually does today
- **PROPOSED** — what Phase 5B should add/change
- **DECISION NEEDED** — must be approved before implementation

This plan is based on the **implemented** Phase 5A code, not on unimplemented future tables in `docs/database.md`.

---

## 1. Current Phase 5A architecture summary

### 1.1 Domain models that exist (Prisma)

From `prisma/schema.prisma` (header: “Phase 1–5A”):

| Model | Role today |
|---|---|
| `Consultation` | Customer request. Status: `PENDING / ACCEPTED / DECLINED / EXPIRED / CANCELLED`. Stores snapshotted `requestedPrice` (`Decimal(12,2)`), snapshotted service names, preferred UTC times, 12h `expiresAt`. Has unused `completedAt`. **Not an appointment.** |
| `ConsultationProposal` | Astrologer-proposed UTC start/end + `durationMinutes`. Status: `PENDING / ACCEPTED / REJECTED / SUPERSEDED`. Schema comment: *“Not a reservation, payment, or confirmed appointment (Phase 5B+).”* |
| `AstrologerBookingGuard` | One row per astrologer. Comment: *“Sync primitive for future appointment reservations (SELECT … FOR UPDATE).”* |
| `WeeklyAvailability` / `AvailabilityException` | Colombo local weekly windows + date exceptions |
| `AstrologerService` / `Service` | Live catalog prices; request snapshots `requestedPrice` at create time |
| `User` | `referralCode` + `referredByUserId` only. No settlement/ledger tables |
| `File` / `ConsultationFile` | Metadata only (R2 not integrated) |
| `AuditLog` | Admin-only (`adminUserId` required) |
| `UserDevice.fcmToken` | Stored; no FCM send path |

**CURRENT — models that do not exist:** `Appointment`, `BookingReservation`, `Payment`, `PaymentAttempt`, `Refund`, `LedgerTransaction`, wallet/payout.

### 1.2 Consultation state machine (implemented)

File: `src/consultations/consultation.state.ts`

```text
PENDING
 ├── ACCEPT          → ACCEPTED
 ├── DECLINE         → DECLINED
 ├── TIMEOUT         → EXPIRED
 └── CUSTOMER_CANCEL → CANCELLED
```

- Terminal for the **request** lifecycle: `DECLINED`, `EXPIRED`, `CANCELLED`
- `ACCEPTED` is **not** “confirmed appointment”
- Customer cancel is only allowed while `PENDING`
- 12h SLA: `CONSULTATION_RESPONSE_TIMEOUT_HOURS = 12` (`consultation.constants.ts`)
- Expiration is **check-on-read / check-on-action** via `expireIfDue` / `expireDuePendingForCustomer` / `expireDuePendingForAstrologer` — idempotent `updateMany` on `PENDING AND expiresAt <= now`. **No BullMQ.**

### 1.3 Proposal state machine (implemented)

File: `src/consultations/proposal.state.ts`

```text
PENDING
 ├── CUSTOMER_ACCEPT → ACCEPTED
 ├── CUSTOMER_REJECT → REJECTED
 └── SUPERSEDE       → SUPERSEDED
```

- Consultation stays `ACCEPTED` after proposal accept
- One `PENDING` and one `ACCEPTED` proposal per consultation (enforced in `ConsultationProposalsService`)
- `canCreateProposal` requires consultation `ACCEPTED`, no pending, no accepted

### 1.4 APIs that exist

Customer (`ConsultationsController`, JWT + `RolesGuard`, `PUBLIC`):

- `POST /consultations` — request (no reservation)
- `GET /consultations/me`
- `GET /consultations/:id`
- `POST /consultations/:id/cancel` — PENDING only
- `GET /consultations/:consultationId/proposals`
- `POST /consultations/:consultationId/proposals/:proposalId/accept`
- `POST /consultations/:consultationId/proposals/:proposalId/reject`

Astrologer (`AstrologerConsultationsController`, JWT + `ASTROLOGER`):

- `GET /astrologers/me/consultations`
- `GET /astrologers/me/consultations/:id` (sets `viewedAt` once; does not extend expiry)
- `POST /astrologers/me/consultations/:id/accept|decline`
- `POST /astrologers/me/consultations/:consultationId/proposals`
- `GET /astrologers/me/consultations/:consultationId/proposals`

**CURRENT — no payment, reservation, webhook, or Confirm & Pay endpoints.**

### 1.5 Availability + occupancy (implemented)

- `AvailabilityCalculator.enumerateSlots` accepts injectable `OccupiedInterval[]` and expands occupied ranges by `APPOINTMENT_BUFFER_MINUTES` (10).
- Constants (`availability.constants.ts`): timezone `Asia/Colombo`, lead 60 minutes, horizon 30 days, duration 15–240, slot grain 30 minutes.
- `AvailabilityService.assertProposedSlotEligible` validates a proposed start+duration against weekly/exceptions/lead/horizon/occupied. Does **not** reserve.
- `AvailabilityService.getPublicSlots` currently passes `occupied: []` with comment *“Phase 5+ injects appointments/reservations”*. **Public slot lists do not hide accepted-proposal times.**
- `ConsultationProposalsService.loadBlockingIntervals` treats **other consultations’ `ACCEPTED` proposals** as soft occupancy **only when creating a new proposal**. It does **not** create reservation rows.

### 1.6 BookingGuard (implemented, barely used)

File: `src/availability/booking-guard.service.ts`

- `ensureGuard` upserts `AstrologerBookingGuard`
- `withAstrologerLock` runs `prisma.$transaction`, then `SELECT … FOR UPDATE` on the guard row, then `work(tx)`
- **Used today only** when an astrologer **creates** a proposal
- **Not used** when a customer **accepts** a proposal
- Proposal accept uses a plain `$transaction` with `updateMany` + supersede; it does **not** re-check availability or cross-consultation overlap

### 1.7 Money / time / Redis / config

- Money: `src/common/money/money.ts` — `Prisma.Decimal`, API as 2-decimal **string** (`toMoneyString`). Never JS float as source of truth.
- Request create snapshots `astrologerService.price` server-side. `CreateConsultationDto` has **no price field**. Flutter cannot set the amount.
- Times: stored UTC; displayed Colombo via Luxon + `BUSINESS_TIMEZONE`.
- Redis: OTP rate limits (`otp:*`) and health. No reservation keys. No BullMQ.
- Env (`EnvironmentVariables`): `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, JWT secrets, `BUSINESS_TIMEZONE`. No PayHere keys.
- Provider pattern already used: `SMS_SENDER` + `SmsSender` + `ConsoleSmsSender`.

### 1.8 Auth, errors, audit

- JWT access + `JwtAuthGuard` + `@Roles(...)` + `RolesGuard`
- Exceptions: `BadRequestException`, `ConflictException`, `ForbiddenException`, `NotFoundException`, `UnauthorizedException`
- `AuditService.record` requires `adminUserId` — not suitable for customer payment events as-is

### 1.9 E2E safety (must not be weakened)

- Dev DB: `welapathkade` via `.env`
- E2E DB: `welapathkade_test` via `.env.test` + `test/load-env-test.cjs`
- Cleanup: `test/e2e-cleanup.ts` → `assertTestDatabase()` then `deleteMany` (proposals first)
- Guard (`src/common/database-safety/assert-test-database.ts`) requires `NODE_ENV === "test"` **and** database name exactly `welapathkade_test`
- Scripts: `test:e2e`, `test:e2e:setup`, `test:e2e:migrate`

### 1.10 Flutter (CURRENT)

- Models/enums match backend 5A statuses only (`consultation.dart`)
- Repository methods: create/list/get/cancel/accept/decline + proposal CRUD/accept/reject. **No payment methods.**
- After accepted proposal, customer UI shows `nextStepPayment` / `nextStepPaymentReservation` copy only — no Confirm & Pay action
- Separate **prototype** screens exist (`consultation_demo_screens.dart`) with “Confirm & pay” / “Booking confirmed” — visual only, not wired to API
- Controllers are account-scoped `ChangeNotifier`s in `main.dart`
- `ApiClient` (Dio): JWT attach + refresh; timeouts 15/20s

### 1.11 Admin (CURRENT)

- Next.js BFF: `/api/admin/[...path]` → backend `/admin/...`
- Live: auth, astrologers, services, users
- `/consultations`, `/payments`, `/referrals` are **placeholder pages**
- No admin payment/consultation APIs on the backend `AdminModule`

### 1.12 Existing product docs vs implemented code

`docs/state-machines.md` §3–4 and `docs/business-rules.md` §10 describe a future `Appointment` starting at `PAYMENT_PENDING` immediately after proposal accept, 30-minute payment window, and a richer appointment lifecycle (`IN_PROGRESS`, no-shows, disputes). **Those models and transitions are not in Prisma or services.** Phase 5B must not treat them as already built.

---

## 2. Phase 5B goals

1. After a customer accepts a proposal, they can **Confirm & Pay**.
2. Confirm & Pay creates a **temporary reservation** of that proposal’s slot **and** starts a **payment attempt** in one server-side transactional flow.
3. The slot is blocked for other customers while the reservation is valid.
4. Payment success is decided **only** by server verification / gateway callback — never by Flutter saying “paid”.
5. On verified payment, a **confirmed appointment** exists and keeps blocking the slot.
6. Duplicate callbacks and retries are idempotent.
7. Concurrent Confirm & Pay for overlapping times: **only one** succeeds.
8. Expired unpaid reservations release the slot (even if a worker has not flipped the row yet).
9. Amount charged is the **server snapshot** (`Consultation.requestedPrice`), not a client-supplied price.
10. Payment gateway is an **interface**; PayHere is a provider behind it (live PayHere may be deferred).
11. E2E isolation (`welapathkade_test` + `assertTestDatabase`) remains unchanged in strength.

---

## 3. Explicit Phase 5B non-goals

Do **not** implement in 5B:

- Live PayHere production go-live (optional later; interface + mock/sandbox first)
- Referral commission calculation, wallets, payouts, ledger settlement
- Refund execution / PayHere refund API (schema may allow a later `REFUNDED` without building the flow)
- Customer/astrologer cancellation-after-payment (100% refund rule stays a later phase)
- Consultation `CONFIRMED` status (do not overload Phase 4 statuses)
- Session lifecycle: `IN_PROGRESS`, `COMPLETED`, no-show, dispute, video/audio
- BullMQ / workers “because the architecture doc mentions them”
- R2 uploads / real file bytes
- FCM / Notify.lk
- Admin payments UI (placeholder can stay)
- Weakening or bypassing `assertTestDatabase`
- `prisma migrate reset`, `DROP DATABASE welapathkade`, `docker compose down -v`

---

## 4. Proposed business flow

```text
CURRENT 5A (unchanged)
  Customer request → Consultation PENDING
       → Astrologer accept → Consultation ACCEPTED
       → Astrologer proposes → Proposal PENDING
       → Customer accept/reject → Proposal ACCEPTED | REJECTED
       Consultation remains ACCEPTED

PROPOSED 5B
  Proposal ACCEPTED
       → Customer Confirm & Pay
       → Server (under astrologer lock):
            expire stale holds
            re-validate slot vs occupancy
            create Appointment PAYMENT_PENDING  (this IS the reservation)
            create Payment PENDING
            return checkout payload from PaymentGateway
       → Customer completes checkout (app / gateway page)
       → Gateway notify/verify (server)
            if PAID and reservation still valid → Appointment CONFIRMED, Payment PAID
            if already PAID → no-op (idempotent)
            if reservation expired → do NOT confirm; mark payment EXPIRED/FAILED (late-pay policy)
       → If customer never pays before reservationExpiresAt
            Appointment PAYMENT_EXPIRED (or treated as expired on read)
            slot free again
```

**CURRENT gap this flow closes:** today an `ACCEPTED` proposal is only a scheduling agreement. Public slots ignore it. Two consultations can accept overlapping times. 5B occupancy must become real.

---

## 5. Proposed state machines

### 5.1 Consultation (unchanged)

Keep Phase 4 machine as-is. **Do not** add `CONFIRMED` / `PAID` to `ConsultationStatus`.

`Consultation.completedAt` exists in schema and is **unused** in `src/`. Leave it unused in 5B.

### 5.2 Proposal (unchanged)

Keep Phase 5A machine. Proposal `ACCEPTED` still means “customer agreed to this time,” not “paid / reserved / confirmed.”

**PROPOSED occupancy rule change (not a proposal status change):**

- Until Confirm & Pay: `ACCEPTED` proposals remain **soft occupancy** when proposing/confirming (same idea as `loadBlockingIntervals`) **plus** they must be injected into **public slot enumeration** (today they are not).
- After Confirm & Pay: `Appointment` in `PAYMENT_PENDING` (unexpired) or `CONFIRMED` is the **hard** occupancy source.

**DECISION NEEDED:** Should an `ACCEPTED` proposal block the slot *before* Confirm & Pay?

- **Option A (recommended):** Yes — treat accepted-proposal intervals as occupied (with buffer), so two customers cannot both hold the same agreed time. Confirm & Pay then upgrades that hold to a timed payment reservation.
- **Option B:** No — slot stays free until Confirm & Pay. Simpler, but a second customer can Confirm & Pay a different consultation’s overlapping accepted proposal first; the first customer’s later Confirm & Pay fails. Matches “only reservation holds the slot” more literally.

### 5.3 Appointment (PROPOSED — V1 only)

Do **not** implement the full `docs/state-machines.md` appointment machine (IN_PROGRESS, no-shows, disputes) in 5B.

```text
PAYMENT_PENDING     created at Confirm & Pay; slot held until reservationExpiresAt
 ├── PAYMENT_SUCCESS → CONFIRMED
 ├── PAYMENT_TIMEOUT → PAYMENT_EXPIRED
 └── ABANDON         → CANCELLED          (optional V1; see decisions)

CONFIRMED           paid + slot owned. Terminal for 5B.
PAYMENT_EXPIRED     unpaid hold lapsed. Slot free. Terminal for this row.
CANCELLED           customer abandoned checkout before pay. Terminal for this row.
```

V1 does **not** need: `IN_PROGRESS`, `COMPLETED`, `NO_SHOW_*`, `TECHNICAL_FAILURE`, `DISPUTED`.

### 5.4 Payment (PROPOSED — V1)

Do not blindly copy CREATED / REFUNDED.

```text
PENDING     checkout created; awaiting gateway
 ├── SUCCESS_VERIFIED → PAID
 ├── GATEWAY_FAILURE  → FAILED      (retry = new attempt, not mutate PAID)
 ├── HOLD_TIMEOUT     → EXPIRED
 └── ABANDON          → CANCELLED   (optional, aligned with appointment CANCELLED)

PAID        terminal success. Duplicate callbacks stay PAID.
FAILED      this attempt failed; customer may Confirm & Pay again if hold still valid
EXPIRED     hold died before pay
CANCELLED   abandoned
```

**Omit from V1 enum (or add unused, no transitions):** `CREATED` (create the row as `PENDING`), `REFUNDED` (later phase).

Why these states:

| State | Needed in V1? | Why |
|---|---|---|
| PENDING | Yes | Checkout exists; webhook may arrive later |
| PAID | Yes | Authoritative success |
| FAILED | Yes | Distinguish “try again” from paid |
| EXPIRED | Yes | Align with reservation timeout |
| CANCELLED | Optional | Only if we expose abandon API |
| CREATED | No | Extra state with no UI |
| REFUNDED | No | No refund flow in 5B |

### 5.5 Reservation statuses

**Recommended: do not add a separate `BookingReservation` status machine.**

The appointment row **is** the reservation:

| Appointment status | Reservation meaning |
|---|---|
| `PAYMENT_PENDING` and `reservationExpiresAt > now` | ACTIVE hold |
| `PAYMENT_PENDING` and `reservationExpiresAt <= now` | expired hold (treat as free even before row update) |
| `CONFIRMED` | CONFIRMED |
| `PAYMENT_EXPIRED` / `CANCELLED` | RELEASED |

If a separate `BookingReservation` table is preferred, equivalent states would be `ACTIVE / EXPIRED / CONFIRMED / RELEASED`. That duplicates `Appointment` for V1.

---

## 6. Proposed database changes

### 6.1 Why a separate Appointment (recommended)

Do **not** turn `ConsultationProposal` into the appointment.

Reasons from current code:

1. Schema and `proposal.state.ts` already say proposal ACCEPTED ≠ payment/appointment.
2. `ConsultationStatus` is a request machine; adding `CONFIRMED` would break Phase 4 lock rules (`isConsultationRequestActionLocked`).
3. `AvailabilityCalculator` is built to inject occupied intervals from future appointments/reservations — not to treat proposal rows as the booking entity.
4. `BookingGuardService` comments describe locking around appointment writes.
5. Later session/no-show states would further overload proposal or consultation if we skip Appointment.
6. `docs/state-machines.md` already planned a separate Appointment (unimplemented). Align 5B V1 with a **slim** version of that, not the full lifecycle.

Do **not** create Appointment at proposal accept (that would create unpaid appointments automatically). Create it at **Confirm & Pay** so “confirmed” can never mean “unpaid.”

### 6.2 Why not a separate BookingReservation table (recommended)

One row with `PAYMENT_PENDING` + `reservationExpiresAt` is enough for V1 hold + confirm. A second table adds joins without extra concurrency power (`AstrologerBookingGuard` already serializes writes).

### 6.3 Why a Payment table (required)

Gateway callbacks, retries, and idempotency need a durable payment identity independent of appointment status. Flutter refresh after timeout must be able to poll “was it paid?”

### 6.4 Why PaymentAttempt (recommended)

One `PAYMENT_PENDING` appointment may see:

- user retry checkout
- app kill during gateway
- duplicate notify

**PROPOSED:** `Payment` (business payment for one appointment) + `PaymentAttempt` (one gateway session / merchant invoice). Unique gateway ids live on the attempt.

**DECISION NEEDED:** single `Payment` row per attempt vs Payment + PaymentAttempt. Recommendation: **both**.

### 6.5 Proposed Prisma shapes (illustrative — not a migration)

```text
enum AppointmentStatus {
  PAYMENT_PENDING
  CONFIRMED
  PAYMENT_EXPIRED
  CANCELLED
}

enum PaymentStatus {
  PENDING
  PAID
  FAILED
  EXPIRED
  CANCELLED
}

enum PaymentProvider {
  MOCK
  PAYHERE
}

model Appointment {
  id                    String
  consultationId        String
  proposalId            String            @unique   // one appointment lineage per accepted proposal
  customerId            String
  astrologerId          String
  startAt               DateTime          // copy of proposal.proposedStartAt (UTC)
  endAt                 DateTime          // copy of proposal.proposedEndAt
  durationMinutes       Int
  status                AppointmentStatus
  amount                Decimal           @db.Decimal(12, 2)  // copy of consultation.requestedPrice
  currency              String            @default("LKR")
  reservationExpiresAt  DateTime
  confirmedAt           DateTime?
  createdAt / updatedAt

  @@index([astrologerId, status, startAt])
  @@index([customerId, status])
  @@index([status, reservationExpiresAt])
}

model Payment {
  id              String
  appointmentId   String
  consultationId  String
  amount          Decimal  @db.Decimal(12, 2)
  currency        String   @default("LKR")
  status          PaymentStatus
  provider        PaymentProvider
  createdAt / updatedAt / paidAt?
}

model PaymentAttempt {
  id                    String
  paymentId             String
  provider              PaymentProvider
  merchantReference     String   @unique   // our idempotency key
  providerPaymentId     String?  @unique   // gateway id once known
  status                PaymentStatus
  checkoutPayload       Json?              // non-secret checkout fields only
  rawNotifyPayload      Json?              // store for audit; redact secrets in logs
  createdAt / updatedAt
}
```

Constraints to enforce in application + DB:

- At most one `Appointment` per `proposalId`
- At most one `PAYMENT_PENDING` appointment per proposal (implied by unique `proposalId`)
- `amount` always copied from `Consultation.requestedPrice`, never from the client
- `startAt`/`endAt` copied from the accepted proposal, never from the client

**Do not** add settlement/commission columns unless Decision 6.6 is “snapshot referral parties now.”

### 6.6 Referral snapshot (boundary)

**CURRENT:** `User.referredByUserId` + `referralCode`. Public referrer resolution exists. No 3%/6%/80% math in code.

**PROPOSED for 5B:** do **not** calculate commissions. Optionally copy immutable ids onto Appointment at confirm (`customerReferredByUserId`, `astrologerReferredByUserId`) so later settlement sees the graph at pay time.

**DECISION NEEDED:** snapshot referral FKs on Appointment now vs defer entirely. Recommendation: **defer** — `User.referredByUserId` is already durable; settlement is out of scope. Revisit if referrer can change (it cannot today).

---

## 7. Proposed API endpoints

All except webhook: existing `JwtAuthGuard` + `RolesGuard`.

### Customer (PUBLIC)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/consultations/:consultationId/proposals/:proposalId/checkout` | Confirm & Pay: lock, reserve, create payment, return checkout payload |
| `GET` | `/consultations/:consultationId/appointment` | Current appointment + payment status (for poll after return-to-app) |
| `POST` | `/consultations/:consultationId/appointment/sync` | Optional: server-side `verifyPayment` when app resumes (does not trust client “success”) |

Reject checkout unless:

- user owns the consultation
- consultation is `ACCEPTED`
- proposal is `ACCEPTED` and belongs to that consultation
- no `CONFIRMED` appointment already exists for that proposal
- if `PAYMENT_PENDING` still valid: return **same** checkout (idempotent retry)
- if previous hold `PAYMENT_EXPIRED`: allow a new checkout only if slot still free

### Webhook (no JWT)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/payments/callbacks/:provider` | Gateway notify. Verify signature. Idempotent finalize. |

Must not use `JwtAuthGuard`. Protect with provider signature + IP allowlist (config).

### Astrologer

Read-only enrichment is enough for 5B:

- Existing detail/list should include `appointment` summary (`PAYMENT_PENDING` / `CONFIRMED` / none)
- No astrologer “confirm payment” endpoint

### Admin

**PROPOSED:** none required for 5B correctness. `/payments` placeholder can stay.

---

## 8. PaymentGateway abstraction

Follow the existing `SMS_SENDER` / `SmsSender` / `ConsoleSmsSender` pattern.

**PROPOSED** (`src/payments/` — new module):

```text
PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY')

interface PaymentGateway {
  readonly provider: 'MOCK' | 'PAYHERE'

  createCheckout(input: {
    merchantReference: string
    amount: MoneyString        // already snapshotted
    currency: 'LKR'
    appointmentId: string
    consultationId: string
    customer: { id: string; name?: string; phone?: string }
    returnUrl: string
    cancelUrl: string
    notifyUrl: string
  }): Promise<{
    checkout: Record<string, unknown>  // Flutter/web checkout fields; no secrets that must stay server-only beyond hash
  }>

  verifyNotify(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{
    merchantReference: string
    providerPaymentId: string
    amount: MoneyString
    currency: string
    success: boolean
  }>

  verifyByReference(merchantReference: string): Promise<{
    providerPaymentId?: string
    amount?: MoneyString
    success: boolean
    pending: boolean
  }>
}
```

Business services (`AppointmentsService` / `PaymentsService`) call this interface only. They own state transitions.

**CURRENT analog:** `AuthModule` binds `SMS_SENDER` → `ConsoleSmsSender`. 5B should bind `PAYMENT_GATEWAY` → `MockPaymentGateway` in development/test, `PayHereGateway` when configured.

---

## 9. PayHere integration boundary

**PROPOSED boundary:** only `PayHereGateway` knows merchant id, secret, checkout URL, md5/hmac notify rules, and PayHere field names.

Core must never:

- parse PayHere-specific form fields except via `verifyNotify`
- mark PAID because Flutter posted `status=success`
- store the merchant secret in Flutter or admin BFF

**V1 without live PayHere:**

- `MockPaymentGateway.createCheckout` returns a local mock checkout (e.g. `{ mock: true, merchantReference }`)
- `POST /payments/callbacks/mock` (test/dev only) or `verifyByReference` that the mock flips to success
- E2E uses mock notify — never hits PayHere

**When PayHere is enabled:** env vars (new, not committed): `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET`, `PAYHERE_CHECKOUT_URL`, `PAYHERE_NOTIFY_URL`, `PAYHERE_SANDBOX=true`. Validate in `EnvironmentVariables` only when provider is `PAYHERE`.

Flutter talks to **our** checkout payload, not PayHere SDK as the source of truth.

---

## 10. Reservation design

Reservation = `Appointment` with `status = PAYMENT_PENDING` and `reservationExpiresAt`.

Created only inside `BookingGuardService.withAstrologerLock`.

Hold duration: **DECISION NEEDED.** Existing `docs/business-rules.md` §10 says **30 minutes**. That is documentation, not code. Recommend constant `PAYMENT_RESERVATION_MINUTES = 30` next to other availability constants.

Occupancy sources for `OccupiedInterval[]` (PROPOSED helper, e.g. `loadOccupiedIntervals(astrologerId)`):

1. `Appointment` where `status = CONFIRMED`
2. `Appointment` where `status = PAYMENT_PENDING` AND `reservationExpiresAt > now`
3. **If Decision 5.2 Option A:** `ConsultationProposal` `ACCEPTED` that has **no** `CONFIRMED` / valid `PAYMENT_PENDING` appointment yet

Always apply `APPOINTMENT_BUFFER_MINUTES` via the existing calculator.

`getPublicSlots` must stop using `occupied: []`.

---

## 11. Appointment design

**What “confirmed appointment” means in 5B:**

A row in `Appointment` with `status = CONFIRMED`, created only after:

1. Customer started Confirm & Pay (so a hold existed), **and**
2. Server verified payment (`verifyNotify` or `verifyByReference`), **and**
3. Hold was still valid (`reservationExpiresAt > now` and status still `PAYMENT_PENDING`) at finalize time, **and**
4. Conditional update `PAYMENT_PENDING → CONFIRMED` affected exactly one row

It does **not** mean:

- Consultation became a new status
- Proposal became something other than `ACCEPTED`
- Flutter showed a success screen

Copy fields from proposal + consultation at hold creation so later catalog price/name changes cannot rewrite a paid booking’s time or amount.

---

## 12. Concurrency strategy

**CURRENT race:** two customers can accept overlapping proposals; public slots ignore occupancy; accept does not take `AstrologerBookingGuard`.

**PROPOSED:**

```text
Customer A Confirm & Pay 10:00          Customer B Confirm & Pay 10:00
        │                                        │
        └──── withAstrologerLock(astroId) ───────┘
                    (MySQL row lock)
                         │
              expire stale PAYMENT_PENDING
              load occupied (+ buffer)
              assertProposedSlotEligible
              if overlap → ConflictException
              create Appointment PAYMENT_PENDING
              create Payment + Attempt
              createCheckout(...)
                         │
                    commit + unlock
```

Only one transaction holds `SELECT … FOR UPDATE` on that astrologer’s guard. The second waits, then sees occupancy, then fails.

Also:

- Unique `Appointment.proposalId` prevents two holds for the same proposal
- Proposal accept should **also** run under the same lock and occupancy check (**PROPOSED 5A hardening inside 5B**) so two overlapping **proposal accepts** cannot both succeed before anyone pays (if Option A)

Prisma `$transaction` default isolation is typically Repeatable Read on MySQL 8; the **guard row lock** is the actual serializer (already implemented). Do not replace it with Redis locks.

---

## 13. Idempotency strategy

| Event | Rule |
|---|---|
| Duplicate Confirm & Pay (same proposal, hold still valid) | Return existing `PAYMENT_PENDING` appointment + existing or refreshed checkout; do **not** create a second appointment |
| Confirm & Pay after `CONFIRMED` | Return existing confirmed appointment; no new payment |
| Duplicate webhook (same `merchantReference` / `providerPaymentId`) | `updateMany` where payment is `PENDING` and appointment is `PAYMENT_PENDING`. If count is 0 and already `PAID`/`CONFIRMED` → 200 OK no-op |
| Unique `PaymentAttempt.merchantReference` | Insert-or-find; never two attempts with same reference |
| Unique `providerPaymentId` | Second insert fails; treat as already processed |
| Flutter “I paid” | **Forbidden.** App may only call `GET appointment` or `POST appointment/sync` which re-verifies with the gateway |
| Network timeout after pay, app never sees success | Webhook still finalizes. App poll shows `CONFIRMED` |
| Retry checkout after FAILED, hold valid | New `PaymentAttempt` under same `Payment` or same appointment; old attempt stays `FAILED` |
| Late webhook after `reservationExpiresAt` | Do **not** confirm. Mark attempt `EXPIRED`/`FAILED`. **DECISION NEEDED:** auto-refund later vs manual ops. 5B records the late pay; does not invent refund |

Webhook handler must be **safe to run twice** and **must not** create a second appointment or second PAID payment.

---

## 14. Expiration strategy

**CURRENT pattern to copy:** consultation `expireIfDue` — conditional `updateMany`, no worker.

**PROPOSED V1 (no BullMQ):**

1. **Check-on-action:** Confirm & Pay, proposal create/accept, slot listing, appointment GET — expire overdue `PAYMENT_PENDING` first (`status = PAYMENT_PENDING AND reservationExpiresAt <= now` → `PAYMENT_EXPIRED`; related `Payment` `PENDING` → `EXPIRED`).
2. **Check-on-read occupancy:** when building `OccupiedInterval[]`, **exclude** holds with `reservationExpiresAt <= now` even if the status row was not updated yet (same rule `docs/state-machines.md` already states for future reservations; `business-rules.md` §13).
3. **No Redis TTL as source of truth.** Redis can die; MySQL `reservationExpiresAt` is authoritative.
4. **Background sweep:** not required for correctness. Optional later if expired rows pile up. Do not add BullMQ in 5B.

Flutter should poll `GET …/appointment` after returning from checkout; expiration is applied on that read.

---

## 15. Money / price snapshot strategy

**CURRENT:**

- Catalog: `Service.minPrice/maxPrice`, `AstrologerService.price` as `Decimal(12,2)`
- On request create: `requestedPrice: astrologerService.price` inside a transaction
- API: `requestedPrice` as string via `toMoneyString`
- Flutter `CreateConsultationDto` equivalent body has no price

**PROPOSED:**

- Authoritative charge amount = `Consultation.requestedPrice` at Confirm & Pay
- Copy onto `Appointment.amount` and `Payment.amount`
- Gateway `createCheckout` / `verifyNotify` amounts must equal that snapshot (`toMoneyString` compare)
- If notify amount mismatches → do **not** mark PAID; `FAILED` + ops log
- Flutter Confirm & Pay body: consultationId + proposalId only — **no amount field**
- Rounding: already 2 decimal places; no new rounding rules
- Currency: `LKR` (not in schema today; add on Appointment/Payment)

Price changes to `AstrologerService` after request create **must not** change the checkout amount.

---

## 16. Referral handling boundary

**CURRENT:** identity graph only. `resolvePublicReferrer` requires a PUBLIC referrer. Astrologer users also have `referralCode` / `referredByUserId` columns; 3%/6%/80% is **documentation** (`docs/business-rules.md` / `AGENTS.md`), not code.

**PROPOSED:** Phase 5B does **not** create commission rows, wallets, or payout reservations. Payment correctness does not require settlement.

Do not hook “PAID → create ledger” in 5B; that is how duplicate webhooks would later create duplicate commissions (`business-rules.md` §11). Settlement should be a later idempotent phase keyed by `appointmentId`.

---

## 17. Refund boundary

**CURRENT:** customer cancel only while consultation `PENDING`; comment in business rules: no refund because no payment.

**PROPOSED 5B:** prepare mentally only.

- Do **not** add refund APIs, refund state machine, or PayHere refund calls
- V1 cancellation-after-`CONFIRMED` (100% refund) is a later phase
- Payment model should not make a later `REFUNDED` status impossible (add the enum later when needed)
- Late payment after expiry: record + do not confirm; refund ops later

---

## 18. Flutter changes

**PROPOSED** (only after backend checkout exists):

1. Domain: `Appointment`, `Payment` views; do **not** add fake consultation statuses
2. Repository: `startCheckout`, `getAppointment`, optional `syncAppointment`
3. Customer detail: if `acceptedProposal != null` and no `CONFIRMED` appointment → **Confirm & Pay** button (replace copy-only `nextStepPayment`)
4. Checkout screen: show snapshotted price/time from **server** response; open mock or PayHere checkout from payload
5. Return/resume: poll/sync until `CONFIRMED` / `PAYMENT_EXPIRED` / `FAILED`
6. Confirmed screen: reuse intent of prototype `ConsultationConfirmedScreen` but bind to real data
7. Astrologer detail: show pending payment vs confirmed (read-only)
8. Routing: real routes under `/consultations/:id/pay` (not the prototype `/consultation/payment` demo)
9. Errors: existing `AppException` + snackbar/banner pattern
10. **Never** POST `status=PAID`

Keep prototype demo screens isolated so they cannot be mistaken for the live flow.

---

## 19. Admin changes

**PROPOSED for 5B:** none required.

Optional later: read-only payments list via BFF. Current `AdminModule` has no consultations/payments controllers; `/payments` is a placeholder. Do not block 5B on admin.

Do not write customer payment events to `AuditLog` without changing that model (`adminUserId` is required).

---

## 20. Backend unit tests

New / extended (mirror existing `*.spec.ts` style):

- Appointment state transitions (illegal jumps throw)
- Payment state transitions + idempotent PAID
- Confirm & Pay: happy path; duplicate call returns same hold; overlap under lock fails
- Amount mismatch on notify → not PAID
- Notify after expiry → not CONFIRMED
- Occupancy helper includes CONFIRMED + valid PENDING + (if Option A) accepted proposals
- Public slots receive occupied intervals (regression on `occupied: []`)
- `MockPaymentGateway` verify/notify
- **Do not** weaken `assert-test-database.spec.ts`

Keep existing proposal/consultation tests passing. Proposal create should still use the booking guard.

---

## 21. Backend E2E tests

New `test/phase5b-payments.e2e-spec.ts`:

- Full 5A path then Confirm & Pay → mock notify → `CONFIRMED`
- Second notify: still one appointment, one PAID payment
- Two customers overlapping 10:00: one `201/200`, one `409`
- Expired hold: checkout after TTL fails or creates a new hold only if free; late notify does not confirm
- Flutter-forged “paid” body rejected / not an API
- Cleanup: extend `resetE2eDatabase` **after** `assertTestDatabase()`:

```text
assertTestDatabase()
delete PaymentAttempt, Payment, Appointment
then existing consultationProposal … user deletes
```

Never point E2E at `welapathkade`. Apply migration with `npm run test:e2e:setup` / `test:e2e:migrate` only.

---

## 22. Flutter tests

Extend `test/phase5a_proposals_test.dart` / new `phase5b_payment_test.dart`:

- Parse appointment/payment JSON
- Confirm & Pay hidden without accepted proposal
- Confirm & Pay hidden when already `CONFIRMED`
- Repository sends no amount
- Controller surfaces 409 overlap
- Fake repository: notify is not called from the widget (no client-side “mark paid”)

---

## 23. Database migration plan

1. Add enums + `Appointment` + `Payment` + `PaymentAttempt` in a **new** folder `prisma/migrations/YYYYMMDDHHMMSS_phase5b_appointments_payments/` — do **not** edit Phase 1–5A SQL.
2. `npx prisma validate` + `prisma generate`
3. Apply to **dev** with `prisma migrate deploy` or `prisma migrate dev` (not `migrate reset`)
4. Apply to **test** with `npm run test:e2e:setup` or `test:e2e:migrate` (creates/migrates `welapathkade_test` only)
5. Confirm `SHOW DATABASES` still has both `welapathkade` and `welapathkade_test`
6. Do **not** `DROP DATABASE`, `TRUNCATE` dev, or `docker compose down -v`

---

## 24. Security considerations

- Webhook is public: signature verify, reject unsigned, do not log merchant secret or raw card data
- Checkout hash/secret stays on server (PayHere merchant secret never in Flutter)
- Confirm & Pay is owner-scoped (`customerId === user.id`)
- No client-supplied amount, start, or end
- Do not expose other customers’ appointments
- `rawNotifyPayload` if stored: treat as sensitive; never return to clients
- Mock callback endpoint **disabled in production** (`NODE_ENV=production` + provider `PAYHERE` only)
- Existing JWT refresh flow unchanged
- Test DB guard unchanged

---

## 25. Failure scenarios

| Scenario | Expected |
|---|---|
| Gateway down at checkout create | No appointment row, or rollback hold; user retries |
| Checkout created, user never pays | Hold expires; slot frees; proposal stays ACCEPTED; new checkout allowed if slot free |
| Paid, webhook delayed, app timeout | Poll/sync eventually CONFIRMED; no double charge if gateway is idempotent; we do not create a second hold |
| Paid after expiry | Not CONFIRMED; record late pay; refund later |
| Two overlapping checkouts | One Conflict |
| Price tampered in Flutter | Ignored; server snapshot used; notify amount mismatch → not PAID |
| Replay webhook | No-op |
| Astrologer proposes same slot after hold | Rejected via occupancy |
| User accepts two proposals on different consultations for same slot | If Option A + lock on accept: second accept fails. If Option B: second Confirm & Pay fails |
| Consultation cancelled? | Cannot cancel after ACCEPTED today — no change |

---

## 26. Rollback considerations

- Migration is **additive**. Rollback = stop using new endpoints; old 5A APIs keep working
- Do not drop new tables in a hurry if any `CONFIRMED` rows exist
- Feature-flag optional: `PAYMENTS_ENABLED=false` → Confirm & Pay returns 503, 5A UI copy remains
- Mock vs PayHere is a provider bind — reverting PayHere is shipping `MockPaymentGateway` again
- Never roll back by resetting `welapathkade`

---

## 27. Exact implementation order

Do not implement until decisions in §29 are approved.

1. Freeze 5A tests as regression baseline (`npm test`, `npm run test:e2e` on `welapathkade_test` only).
2. Add Prisma models + migration; generate client; migrate **test DB** via `test:e2e:setup`.
3. Extend `resetE2eDatabase` delete order (guard stays first).
4. Appointment + payment state helpers (pure functions + unit tests) — same style as `consultation.state.ts`.
5. Occupancy loader; wire into `getPublicSlots` and proposal create/accept.
6. Harden proposal **accept** under `withAstrologerLock` + occupancy (closes 5A overlap hole).
7. `AppointmentsService.checkout` (lock + hold + payment + gateway.createCheckout).
8. `MockPaymentGateway` + callback/verify finalize (idempotent).
9. Customer GET appointment + optional sync.
10. Enrich existing consultation detail mapper with appointment summary.
11. Env/config for provider + (later) PayHere secrets.
12. Flutter domain/repo/UI poll loop.
13. Unit + E2E 5B suite.
14. `PayHereGateway` behind the same interface when ready — not a blocker for mock E2E.
15. Update `docs/state-machines.md` to mark 5B V1 implemented vs still-future session states.

---

## 28. Files / modules expected to change

**Backend (when implementation is approved):**

- `prisma/schema.prisma` + new migration folder
- `src/consultations/consultation.mapper.ts` (embed appointment)
- `src/consultations/consultation-proposals.service.ts` (occupancy + lock on accept)
- `src/availability/availability.service.ts` (`getPublicSlots` occupied)
- **New** `src/payments/` (module, gateway interface, mock, optional PayHere, callback controller)
- **New** `src/appointments/` or payments-owned appointment service
- `src/consultations/consultations.module.ts` / `app.module.ts` imports
- `src/config/env.validation.ts`, `app.config.ts`, `.env.example` (no secrets committed)
- `src/consultations/consultations.controller.ts` (checkout + get appointment)
- `test/e2e-cleanup.ts`, new e2e spec, new unit specs
- `docs/state-machines.md` (docs-only, after code)

**Flutter:**

- `consultation.dart` / repository / impl / controllers
- `customer_consultation_screens.dart` + new pay/confirmed screens
- `app_router.dart`, l10n arb + generate
- tests

**Admin:** none required.

**Do not change:** `assert-test-database.ts` logic; Phase 1–5A migration SQL; `package.json` except if a PayHere SDK is explicitly approved (prefer raw HTTPS first — **DECISION NEEDED**).

---

## 29. Risks and unresolved decisions

### Risks

1. **5A overlap hole:** accepted proposals do not lock the astrologer row and public slots ignore them. 5B occupancy must be complete or double-booking remains.
2. **Late payment after expiry** without refund tooling — money can sit at gateway.
3. **PayHere sandbox quirks** (notify retries, amount format). Mock E2E first.
4. **Over-building** the full appointment lifecycle from `docs/state-machines.md` would explode 5B scope.
5. **AuditLog** cannot record customer payments without a schema change.
6. **Migration delete order** in E2E if FKs are added carelessly.

### DECISION NEEDED (approval list)

| # | Topic | Recommendation |
|---|---|---|
| D1 | Separate `Appointment` vs reuse accepted proposal as the booking | **Separate Appointment**, created at Confirm & Pay |
| D2 | Separate `BookingReservation` table | **No** — `Appointment.PAYMENT_PENDING` + `reservationExpiresAt` |
| D3 | `Payment` + `PaymentAttempt` vs one table | **Both** |
| D4 | Does accepted proposal block the slot before Confirm & Pay? | **Yes (Option A)** |
| D5 | Reservation TTL | **30 minutes** (matches `docs/business-rules.md`, not yet in code) |
| D6 | Abandon-checkout API / `CANCELLED` | **Skip in V1**; expiry is enough |
| D7 | Snapshot referral FKs on Appointment | **Defer** |
| D8 | Refund / late-pay money movement | **Out of 5B**; do not confirm late pays |
| D9 | Live PayHere in the same PR as mock | **Mock first**; PayHere adapter follow-up |
| D10 | Extra npm PayHere SDK | **No** — HTTPS + documented notify verify |
| D11 | Admin payments list in 5B | **No** |
| D12 | Proposal-accept occupancy + lock in the same 5B change | **Yes** — otherwise D4 is incomplete |

---

## 30. Manual E2E acceptance criteria

Use **development** DB `welapathkade` for manual product checks. Automated `npm run test:e2e` must use **`welapathkade_test` only**.

1. Customer request → astrologer accept → propose 10:00 → customer accept proposal → consultation still `ACCEPTED`, no `Appointment`.
2. Customer Confirm & Pay → sees server price (catalog change does not change it) → mock/sandbox checkout.
3. Complete pay → webhook/verify → appointment `CONFIRMED`. Restart app: still confirmed (poll).
4. Replay webhook: still one appointment, one PAID.
5. Second customer / second consultation overlapping 10:00: proposal or checkout rejected; first confirmed slot stays.
6. Start checkout, do **not** pay, wait past TTL: slot reappears; first appointment `PAYMENT_EXPIRED`; Confirm & Pay can be retried only if still free.
7. Kill app after paying before redirect: reopen detail → becomes `CONFIRMED` without the user tapping “I paid.”
8. Flutter cannot confirm by calling a client-only success handler.
9. After 5B e2e suite: row counts on `welapathkade` unchanged vs before the suite.
10. `assertTestDatabase` still throws if `DATABASE_URL` points at `welapathkade`.

---

## Phase 5B Readiness

### Current Phase 5A status

Implemented and in use: request lifecycle, proposals, Colombo availability, price snapshot, booking-guard **create-proposal** lock, Flutter propose/accept/reject UI, isolated E2E database.

Not implemented: reservation, payment, confirmed appointment, PayHere, occupancy on public slots, lock on proposal accept.

### What is ready

- State-machine style (`consultation.state.ts` / `proposal.state.ts`)
- `BookingGuardService.withAstrologerLock`
- `AvailabilityCalculator` occupied intervals + 10-minute buffer
- `assertProposedSlotEligible`
- Decimal money helpers + request-time price snapshot
- Check-on-read expiration pattern
- Provider injection pattern (`SMS_SENDER`)
- JWT + role guards
- E2E cleanup + `assertTestDatabase`
- Flutter copy already pointing at “next step is payment”

### What Phase 5B will add

- `Appointment` + `Payment` + `PaymentAttempt`
- Confirm & Pay API + webhook/verify
- `PaymentGateway` + mock (PayHere later)
- Real occupancy for slots and locks
- Flutter Confirm & Pay + poll-to-confirmed
- Tests + e2e cleanup for new tables

### Decisions that need approval

D1–D12 in §29. Blocking ones: **D1, D2, D4, D5, D9**.

### Recommended implementation sequence

Decisions → schema/migration on both DBs safely → occupancy + lock on accept → checkout + mock notify → Flutter → E2E → PayHere adapter.

---

*End of plan. No code, migration, or database command from this document has been executed.*

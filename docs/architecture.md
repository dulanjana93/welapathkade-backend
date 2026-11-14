# Welapathkade — System Architecture

## 1. Architecture Style

Welapathkade V1 uses a:

```text
Modular Monolith

Backend:

NestJS + TypeScript

Database:

MySQL

ORM:

Prisma

Cache/coordination:

Redis

Background jobs:

BullMQ
2. High-Level Architecture
                    ┌─────────────────────┐
                    │    Flutter App      │
                    │ Customer/Astrologer │
                    └──────────┬──────────┘
                               │ HTTPS
                               ▼
                    ┌─────────────────────┐
                    │       Nginx         │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │    NestJS API       │
                    │   Modular Monolith  │
                    └──────┬──────┬───────┘
                           │      │
              ┌────────────┘      └─────────────┐
              ▼                                  ▼
       ┌──────────────┐                   ┌──────────────┐
       │    MySQL     │                   │    Redis     │
       │ Source Truth │                   │ Cache/Jobs   │
       └──────────────┘                   └──────┬───────┘
                                                 │
                                                 ▼
                                           ┌────────────┐
                                           │  BullMQ    │
                                           │  Workers   │
                                           └────────────┘

External services:

NestJS
 ├── FCM
 ├── Notify.lk
 ├── Cloudflare R2
 ├── PaymentGateway
 └── CallProvider
3. Frontend Applications
Flutter

Flutter is the primary customer/astrologer application.

The app communicates with the backend through HTTPS APIs.

The Flutter client is never authoritative for:

payment success
price
commission
referral ownership
appointment ownership
financial balances
authorization
4. Admin Application

Admin frontend:

React / Next.js

It communicates with the same backend API.

There is one Admin role in V1.

5. NestJS Modules

Recommended structure:

src/
├── auth/
├── users/
├── astrologers/
├── services/
├── availability/
├── consultations/
├── appointments/
├── payments/
├── financials/
├── referrals/
├── payouts/
├── refunds/
├── disputes/
├── sessions/
├── conversations/
├── reviews/
├── featured/
├── notifications/
├── files/
├── admin/
├── settings/
├── audit/
├── common/
└── main.ts

Exact folder names may evolve, but business boundaries must remain clear.

6. Module Responsibilities
auth

Responsible for:

OTP
authentication
refresh sessions
logout/revocation
device/session management
registration intent via OtpPurpose (PUBLIC_REGISTRATION / ASTROLOGER_REGISTRATION / LOGIN)
role assignment from OTP purpose (never from client-supplied role)
users

Responsible for:

public user profiles
account status
language preference
referral code
referral relationship
customer billing profile (`GET`/`PUT /me/billing`): first name, last name, billing email, address, city, and country. Nullable until the customer is ready to pay. The account phone is reused and is not stored again. Billing email is not the admin login email and does not change `User.name`. Checkout refuses to reserve a slot while any required billing field is missing or invalid (`BILLING_PROFILE_INCOMPLETE`).
astrologers

Responsible for:

astrologer profile
astrologer lifecycle
astrologer-specific configuration
onboarding application (AstrologerApplication)
admin approve/reject of applications
audit of application review actions
services

Responsible for:

platform service catalog
Sinhala/English names
service limits
activation/deactivation
astrologer service selection
astrologer-specific prices
availability

Responsible for:

weekly availability (Asia/Colombo local HH:mm + weekday)
availability exceptions (UNAVAILABLE / AVAILABLE_OVERRIDE)
availability validation
public ACTIVE-astrologer availability reads
available-slot calculation (lead time, horizon, occupied-interval injection)
AstrologerBookingGuard row-lock helper for later appointment writes
consultations

Responsible for:

consultation requests
consultation lifecycle
consultation files (metadata + authorization boundary)
request SLA (12h from submittedAt)
preferred-time eligibility via AvailabilityService (no reservation)
service name/price snapshot at request creation

Phase 4 endpoints:

- POST /consultations (PUBLIC)
- GET /consultations/me (PUBLIC)
- GET /consultations/:id (PUBLIC owner or assigned ASTROLOGER)
- POST /consultations/:id/cancel (PUBLIC owner)
- GET /astrologers/me/consultations (ASTROLOGER)
- GET /astrologers/me/consultations/:id (ASTROLOGER; sets viewedAt once)
- POST /astrologers/me/consultations/:id/accept (ASTROLOGER)
- POST /astrologers/me/consultations/:id/decline (ASTROLOGER)

Does **not** (later phases): appointment proposals, payment, BookingGuard reservation, refunds, chat, video.
appointments

Responsible for:

appointment proposals
appointment reservations
appointment lifecycle
booking conflict checks (uses AvailabilityCalculator + BookingGuardService)
overlap detection
payments

Responsible for:

payment records
payment gateway integration
webhook processing
payment idempotency
checkout billing gate: a public customer must have a complete billing profile before Confirm & Pay creates an appointment, payment, or payment attempt. An incomplete profile returns HTTP 400 `BILLING_PROFILE_INCOMPLETE` with `missingFields` and does not take the astrologer booking lock.
PayHere sandbox and live checkout (`PayHereGateway`). Development and test keep `MockPaymentGateway` unless `PAYHERE_MODE=sandbox`. Production requires `PAYHERE_MODE=live` and refuses the mock gateway. Checkout returns a form POST (`action` plus `fields`, including a server-side hash). The merchant secret is not in the response. `POST /payments/callbacks/payhere` accepts `application/x-www-form-urlencoded`, checks `md5sig`, and ignores card fields. Status `2` confirms a live 30-minute hold. A verified capture after that hold marks the payment paid, sets `FULL_REFUND_DUE`, leaves the appointment unconfirmed, and then requests a full PayHere refund of the captured consultation amount. Customer return uses Retrieval (`GET /merchant/v1/payment/search`) and is not proof by itself. The checkout amount is the consultation price. Settlement stays 80% / 3% / platform residual of that price. Gateway fees are not added to the refund.

Saved cards are separate from consultation payments. `POST /me/payment-methods/preapproval` requires a complete billing profile and `acceptAutomaticPaymentConsent: true`. The form is posted to PayHere’s pre-approval URL and omits `amount`. The hash uses the documented LKR value `10.00`, which is not a consultation charge. PayHere’s automated-charging guide says the card verification charges Rs. 1.00 and refunds it immediately. That notification is matched by an order id starting with `pa_` and never creates an appointment, consultation payment, wallet credit, snapshot, or ledger row. The browser return URL does not activate the card. A verified status `2` with `customer_token` encrypts the token with the existing AES-256-GCM bank-account key and marks the card `ACTIVE`. PayHere passes no status to `return_url`, delivers `customer_token` only through `notify_url`, and its Retrieval API does not cover pre-approvals. So when the PayHere page closes, the app calls `POST /me/payment-methods/:id/complete`. That call waits up to 8 seconds for the verified notify. It then returns `ACTIVE`, or marks the attempt `FAILED` and releases `openCardSlot`, so the customer can retry immediately. Registration is never left `PENDING` for the customer. A new start supersedes an open attempt, and the expiry sweep fails attempts the app never completed after 30 minutes. A verified success that arrives after `FAILED` never reactivates the card. Its token is discarded and `lateAuthorizationAt` is set for manual cancellation in the PayHere merchant portal. See `docs/saved-card-registration.md`. Revoking or removing the card deletes that ciphertext immediately. PayHere does not offer a customer or server API to cancel the provider-side pre-approval. Cancellation of that pre-approval is a separate action in the PayHere merchant account (Payments, Preapprovals). Local revocation still makes the token unusable by Welapathkade. Automatic charging is a separate customer action, `POST /consultations/:consultationId/proposals/:proposalId/checkout/saved-card`, and only runs when the body is `confirmSavedCardPayment: true`. Accepting a proposal does not charge the card. The server loads the consultation price, reserves the existing 30-minute hold, stores one `sc_` payment attempt, and then calls PayHere `POST /merchant/v1/payment/charge` with `type: PAYMENT`. The customer token is decrypted only for that request and is not returned, logged, or stored on the attempt. Manual checkout stays `POST .../checkout` and does not require a saved card. A repeated saved-card request returns the open attempt and does not send another charge. A timeout, an unauthenticated response, or status `0` sets `PaymentAttempt.requiresReview` and keeps `openChargeSlot` until Retrieval matches that same order. Status `2` with a matching signature uses the existing payment finalizer: a live hold is confirmed, and a capture after the hold expires is marked paid with `FULL_REFUND_DUE` and the existing full-refund flow. Status `-1` and `-2` with a valid signature do not confirm. The Charging API shows `md5sig` without its own formula, so the documented checkout notification formula is used. A mismatch stays unresolved. `AUTHORIZE` is not used. Live charging still needs PayHere’s domain and IP whitelist, which is not configured here.

Refund words are separate:

- Refund obligation: `Appointment.refundObligation = FULL_REFUND_DUE`. The customer is owed a refund. Settlement stays blocked while it is set. It is not cleared when PayHere accepts a refund.
- Refund request: `POST /merchant/v1/payment/refund` with the stored PayHere `payment_id` and a fixed description. The amount is omitted so PayHere refunds the captured payment. The amount is never taken from the client.
- Refund processing: internal status `PROCESSING`, or Retrieval status `REFUND REQUESTED` / `REFUND PROCESSING`. Another refund is not sent.
- Confirmed refund: PayHere response status `1` with a refund number, or Retrieval status `REFUNDED`. Internal status `SUCCEEDED`.
- Financial ledger reversal: `FinancialLedgerService.reversePostedSnapshotForRefundObligation`. It claws back an already posted snapshot and is idempotent. It does not prove PayHere refunded the customer, and a PayHere success does not by itself prove the reversal ran. Refund initiation does not create wallet credits.

Status `0`, a timeout, or a dropped connection becomes `REQUIRES_REVIEW` and is not retried until Retrieval shows the payment is still `RECEIVED` (the request never started). Status `-1` is a recorded failure and is also not retried until that same retrieval result. Admin retry is `POST /admin/finance/refunds/:id/retry`. Admins list and inspect refunds at `GET /admin/finance/refunds` and reconcile with `POST /admin/finance/refunds/reconcile`. The expiry sweep starts due refunds that have no refund row yet and reconciles unresolved rows. It does not add a queue. A chargeback (notify status `-3` or Retrieval `CHARGEBACKED`) is not a successful payment, does not start a refund, and sets `manualReviewRequired` so a new settlement credit is blocked. This phase does not reverse a snapshot that was already posted for a chargeback.
financials

Responsible for:

consultation financial snapshot
ledger
commission calculation
financial allocation
settlement
referrals

Responsible for:

referral relationships
referral validation
referral commission inputs
payouts

Responsible for:

payout calculation
payout reservation
gateway payout
payout status
refunds

Responsible for:

refund records
gateway refunds
refund allocation
financial reversals
disputes

Responsible for:

dispute lifecycle
Admin review
dispute resolution
sessions

Responsible for:

call sessions
CallProvider integration
join/start/end tracking
technical failure handling
conversations

Responsible for:

follow-up conversations
messages
48-hour expiry
customer message limit
contact-sharing filter
reviews

Responsible for:

ratings
reviews
edit window
astrologer response
reporting
featured

Responsible for:

featured placements
placement duration
placement payment
notifications

Responsible for:

notification creation
FCM
Notify.lk
notification delivery status

Notifications should normally be processed asynchronously.

files

Responsible for:

file metadata
R2 integration
signed URL generation
authorization
admin

Responsible for:

Admin-only operations
dashboards
management operations
settings

Responsible for configurable business settings.

Examples:

consultation response timeout
payment timeout
commission percentages
referral percentages
settlement hold
appointment buffer
minimum lead time
maximum booking horizon
follow-up duration
customer message limit
minimum payout
featured pricing
audit

Responsible for:

Admin audit logs
sensitive business actions
7. Database

MySQL is the authoritative database.

Prisma is used for normal database access.

Raw SQL may be used where Prisma does not expose the required MySQL functionality.

The primary example is:

SELECT ...
FOR UPDATE

for booking synchronization.

8. Booking Concurrency

Each astrologer has one:

AstrologerBookingGuard

row.

Booking flow:

BEGIN
   |
   v
LOCK AstrologerBookingGuard
   |
   v
Validate consultation
   |
   v
Validate availability
   |
   v
Check overlapping proposals
   |
   v
Check overlapping appointments
   |
   v
Create reservation/proposal
   |
   v
COMMIT

Concurrent booking requests for the same astrologer serialize on the guard row.

9. Redis

Redis is not the source of truth.

Use Redis for:

cache
short-lived coordination
BullMQ
rate limiting where appropriate
temporary locks where appropriate

Critical booking synchronization should use the MySQL booking guard transaction.

10. BullMQ

BullMQ handles asynchronous jobs.

Examples:

expire consultation request
expire appointment proposal
expire payment reservation
release settlement
send appointment reminder
send notification
expire follow-up
process payout
cleanup expired temporary data

Every job should be idempotent.

11. PaymentGateway Abstraction

Create an interface similar to:

interface PaymentGateway {
  createPayment(...): Promise<...>;

  verifyPayment(...): Promise<...>;

  refundPayment(...): Promise<...>;

  createPayout(...): Promise<...>;

  getPaymentStatus(...): Promise<...>;

  getPayoutStatus(...): Promise<...>;
}

Exact methods may change based on implementation.

Business services must depend on the interface, not the concrete provider.

Example:

payments/
├── application/
├── domain/
└── infrastructure/
    └── gateways/
        └── <provider>/
12. CallProvider Abstraction

Create an interface similar to:

interface CallProvider {
  createSession(...): Promise<...>;

  getSession(...): Promise<...>;

  endSession(...): Promise<...>;
}

The selected provider is replaceable.

Do not spread provider-specific SDK calls throughout the business layer.

13. File Storage

Use:

Cloudflare R2

Private bucket.

Flow:

Flutter
   |
   | request upload authorization
   ▼
NestJS
   |
   | authorize
   ▼
Signed upload URL
   |
   ▼
Cloudflare R2

Database stores:

objectKey
bucket
mimeType
size
checksum
owner/uploader
status

Do not store actual file bytes in MySQL.

14. Authorization

Authorization should happen server-side.

Examples:

Customer may access:

their consultations
their files
their appointments
their conversations
their reviews

Astrologer may access:

assigned consultations
assigned customer files
their appointments
their conversations
their earnings

Admin may access according to Admin permissions.

Do not rely on Flutter route visibility as security.

15. API Layer

Recommended flow:

Controller
   ↓
DTO Validation
   ↓
Application Service / Use Case
   ↓
Domain/business logic
   ↓
Repository / Prisma
   ↓
MySQL

Controllers should remain thin.

16. External API Calls

External integrations include:

PaymentGateway
FCM
Notify.lk
Cloudflare R2
CallProvider

Keep integrations isolated.

Do not make business modules depend directly on external SDK internals.

17. Notifications

Correct flow:

Database transaction
        ↓
Commit
        ↓
Create/queue notification job
        ↓
BullMQ
        ↓
FCM / Notify.lk

Avoid making SMS or push calls inside critical database transactions.

18. Time Handling

Business timezone:

Asia/Colombo (fixed for V1 — clients must not supply alternate timezones)

Persist event timestamps in UTC.

Weekly availability is **not** a UTC timestamp: store recurring local clock time + weekday.

Conversion rule for slot calculation:

1. Resolve Asia/Colombo calendar date + weekday.
2. Apply exceptions for that date.
3. Convert each local HH:mm window to UTC via luxon (`Asia/Colombo` → UTC).
4. Apply min lead time (proposal: 5 minutes; public booking slots: 10 minutes) and max horizon (30 days) in absolute time.
5. Subtract occupied intervals after expanding them by the 10-minute scheduling buffer.

Appointment comparisons must use absolute timestamps.

Availability rules must correctly account for the Colombo timezone.

19. Money Handling

Money is:

DECIMAL

Never:

float

Never use floating-point arithmetic for financial calculations.

20. Financial Architecture

Example:

Completed Consultation
        |
        ▼
ConsultationFinancial
        |
        ├── Astrologer earning
        ├── Customer referral
        ├── Astrologer referral
        └── Platform commission
        |
        ▼
Ledger Transactions
        |
        ▼
Settlement Hold
        |
        ▼
Available
        |
        ▼
Payout

The consultation financial snapshot is the immutable source for the original split.

21. Refund Architecture
Refund request
      ↓
Refund record
      ↓
Refund allocation
      ↓
Payment gateway
      ↓
Refund success
      ↓
Ledger reversal/adjustment

Never directly modify balances.

22. Payout Architecture
Eligible ledger
      ↓
Reserve funds
      ↓
Create payout
      ↓
PaymentGateway
      ↓
Success
      │
      └──> consumed

Failure:

Payout FAILED
      ↓
release reservation
      ↓
AVAILABLE
23. Error Handling

Use consistent HTTP errors.

Examples:

400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
422 Unprocessable Entity
429 Too Many Requests
500 Internal Server Error

Business conflicts such as:

appointment already booked
proposal already pending
payment expired
invalid state transition

should normally return a suitable conflict/business error.

24. Logging

Log important technical events.

Do not log:

OTP codes
passwords
refresh tokens
private bank account information
sensitive consultation contents unnecessarily

Use structured logs where possible.

25. Environment Variables

Secrets must be environment variables.

Example:

DATABASE_URL
REDIS_URL
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
FCM credentials
NOTIFY_LK_USER_ID
NOTIFY_LK_API_KEY
NOTIFY_LK_SENDER_ID
R2 credentials
PAYMENT_GATEWAY credentials
CALL_PROVIDER credentials

Never commit secrets.

Provide:

.env.example

with placeholders only.

26. Deployment

Initial deployment target:

DigitalOcean Droplet

Recommended initial size:

2 GB RAM
1 vCPU
50 GB SSD

Scale when actual usage requires it.

Use:

Nginx
HTTPS

Production OTP SMS is sent through Notify.lk. Set `NOTIFY_LK_USER_ID`, `NOTIFY_LK_API_KEY`, and `NOTIFY_LK_SENDER_ID` outside the repository. The sender ID must be approved in the Notify.lk dashboard before production OTP delivery. `NotifyDEMO` cannot be used for OTP.

Production MySQL backups should exist independently of the application container/server lifecycle.

27. Testing Architecture

At minimum:

unit tests
integration tests
database tests
state transition tests
financial tests
booking concurrency tests

Especially test:

two customers booking overlapping times

because double-booking prevention is a critical business requirement.

28. V1 Architecture Principles

Prefer:

simple
transactional
auditable
replaceable integrations
strong database consistency

Avoid:

premature microservices
complex event buses
unnecessary abstractions
AI systems
distributed complexity

The goal of V1 is a reliable modular monolith that can later be split if actual scale requires it.
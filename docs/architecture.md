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
consultation files
request SLA
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
4. Apply min lead time (1 hour) and max horizon (30 days) in absolute time.
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
JWT_SECRET
FCM credentials
NOTIFY credentials
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
# Welapathkade — AI Development Rules

## 1. Project Overview

Welapathkade is a Sri Lankan astrology consultation marketplace.

The platform connects:

- Public users/customers
- Astrologers
- One Admin role

The application supports:

- Sinhala
- English

The system allows customers to request astrology consultations, astrologers to accept and propose appointment times, customers to pay, and both parties to conduct an in-app consultation.

The platform also supports lifetime referral commissions, astrologer earnings, payouts, refunds, disputes, reviews, follow-up messaging, notifications, and featured astrologer placement.

---

# 2. Technology Stack

Backend:

- Node.js
- TypeScript
- NestJS
- Prisma ORM
- MySQL
- Redis
- BullMQ

External services:

- FCM for push notifications
- Notify.lk for SMS
- Cloudflare R2 for private file storage
- Payment gateway through an abstraction/interface
- Video/audio provider through an abstraction/interface

Admin:

- React / Next.js

API documentation:

- Swagger / OpenAPI

Infrastructure:

- DigitalOcean
- Nginx
- HTTPS

Architecture:

- Modular monolith

DO NOT introduce:

- Microservices
- Kafka
- Kubernetes
- Event-driven distributed architecture
- Multiple backend services

unless explicitly requested later.

---

# 3. Core Architectural Principles

## 3.1 MySQL is the source of truth

Business state and financial state must be stored in MySQL.

Redis is used for:

- caching
- temporary coordination
- distributed locks where appropriate
- BullMQ queues

Do not use Redis as the authoritative source of business data.

---

## 3.2 Modular monolith

Organize NestJS by business modules.

Expected modules include:

- auth
- users
- astrologers
- services
- availability
- consultations
- appointments
- payments
- financials
- referrals
- payouts
- refunds
- disputes
- sessions
- conversations
- reviews
- featured
- notifications
- files
- admin
- settings
- audit

Modules may be adjusted when implementation begins, but preserve clear business boundaries.

---

# 4. Money Rules

Money must NEVER be represented using JavaScript floating-point numbers.

Use Prisma Decimal / MySQL DECIMAL.

Example:

```text
DECIMAL(12,2)

All monetary calculations must use exact decimal arithmetic.

Never calculate financial amounts using:

number

when precision matters.

Never directly modify a user's financial balance.

Financial truth must come from ledger transactions.

5. Financial Ledger Rules

The ledger is immutable.

Never:

delete ledger transactions
overwrite historical ledger transactions
directly edit balances
"fix" a balance by changing an old transaction

Corrections must create new ledger transactions.

Examples:

CONSULTATION_EARNING
REFERRAL_COMMISSION
PLATFORM_COMMISSION
REFUND_REVERSAL
PAYOUT
PAYOUT_REVERSAL
ADJUSTMENT

Every financial transaction must be traceable to a business entity using:

referenceType
referenceId

Financial operations must be idempotent.

6. Referral Rules

Public users can refer:

Other public users
Astrologers

Referral relationships are lifetime relationships.

A referral relationship normally cannot be changed after registration.

Only Admin can correct an incorrect referral relationship.

Admin corrections must create an AuditLog entry.

Referral commission:

Customer referrer:
3%

Astrologer referrer:
3%

Both may apply to the same completed consultation.

Example:

Consultation price = Rs.1000

Astrologer = Rs.800
Customer referrer = Rs.30
Astrologer referrer = Rs.30
Platform = Rs.140

Without referrals:

Astrologer = 80%
Platform = 20%

With one referral:

Astrologer = 80%
Referral = 3%
Platform = 17%

With two referrals:

Astrologer = 80%
Customer referral = 3%
Astrologer referral = 3%
Platform = 14%

Referral percentages and referrer IDs must be snapshotted into the consultation financial record.

Future commission configuration changes must NOT change historical consultations.

7. Consultation Rules

Customer submits a consultation request.

Payment is NOT required when the request is submitted.

The astrologer has:

12 hours

to explicitly accept or decline.

Viewing a request does NOT stop the 12-hour timer.

Track:

viewedAt
respondedAt
expiresAt

If the astrologer does not respond before expiry:

PENDING -> EXPIRED
8. Appointment Proposal Rules

After accepting a consultation request, the astrologer proposes an appointment time.

Only one proposal may be pending at a time for a consultation.

A proposal contains:

start time
duration
end time
price
expiry
status

Duration is NOT determined by the platform service catalog.

The astrologer chooses the duration for the individual appointment.

If the customer rejects a proposal, the astrologer may propose another time.

Historical rejected/expired proposals must remain in the database.

9. Payment Rules

After the customer accepts a proposed appointment:

PAYMENT_PENDING

The customer has:

30 minutes

to complete payment.

The payment-pending reservation blocks that appointment time.

If payment is not completed:

PAYMENT_PENDING -> PAYMENT_EXPIRED

The slot becomes available again.

Payment gateway webhooks must be idempotent.

Never trust only the Flutter client to determine payment success.

The backend must finalize payment using the payment gateway's server-side notification/webhook mechanism.

If a payment arrives after the reservation has expired, do NOT blindly confirm the appointment.

Handle the late payment according to the payment/refund flow.

10. Double Booking Prevention

Appointments have variable durations.

Therefore:

UNIQUE(astrologerId, startAt)

is NOT sufficient.

Each astrologer must have exactly one:

AstrologerBookingGuard

row.

When creating or converting a booking:

SELECT astrologer_id
FROM astrologer_booking_guards
WHERE astrologer_id = ?
FOR UPDATE;

The booking guard must be locked inside a MySQL transaction.

Then:

Validate state.
Validate availability.
Check conflicting proposals.
Check conflicting appointments.
Create/update booking state.
Commit.

Overlap rule:

existing.startAt < requestedEnd
AND
existing.endAt > requestedStart

Scheduling must also respect:

APPOINTMENT_BUFFER_MINUTES = 10

The 10-minute buffer is scheduling space.

It is NOT added to the actual appointment duration.

Example:

Appointment:
15:00 - 16:00

Scheduling occupied:
15:00 - 16:10
11. Availability Rules

Timezone:

Asia/Colombo

Database timestamps should be stored in UTC.

Availability supports:

weekly availability
date-specific exceptions
unavailable dates
optional custom available periods

Booking rules:

Proposal minimum lead time = 5 minutes
Public booking-slot minimum lead time = 10 minutes
Maximum booking horizon = 30 days
Default scheduling interval = 30 minutes
Buffer = 10 minutes

Service duration is NOT fixed by the catalog.

Confirmed appointments and valid payment-pending reservations block availability.

Expired reservations must stop blocking availability based on their expiry timestamp even if a background worker has not yet updated their status.

12. Appointment Lifecycle

Main lifecycle:

PAYMENT_PENDING
        |
        v
   CONFIRMED
        |
        v
   IN_PROGRESS
        |
        v
    COMPLETED

Exception states include:

PAYMENT_EXPIRED
CANCELLED_BY_CUSTOMER
CANCELLED_BY_ASTROLOGER
NO_SHOW_CUSTOMER
NO_SHOW_ASTROLOGER
TECHNICAL_FAILURE
DISPUTED
13. Customer Cancellation

Customer may cancel even:

5 minutes before the appointment

Customer cancellation receives:

100% refund

No late cancellation penalty is applied in V1.

14. Astrologer Cancellation

If astrologer cancels:

100% customer refund

Astrologer reliability/ranking should be negatively affected.

Repeated cancellations may trigger Admin review.

15. Technical Failure

If video fails but audio works:

switch to in-app audio

Do not automatically assume that every technical issue deserves a refund.

Technical disputes are reviewable by Admin.

Store session metadata such as:

joined timestamps
start time
end time
leave timestamps
actual duration
technical events where supported

V1 does NOT automatically record audio/video.

16. Follow-up Chat

Follow-up starts after consultation completion.

Duration:

48 hours

Customer:

Maximum 5 messages

Astrologer:

Unlimited replies

After 48 hours:

READ_ONLY

Follow-up chat is text only.

No:

images
files
voice messages
video calls

Consultation request itself may contain:

text
voice note
kundali files/images

Do not expose phone numbers.

Do not expose direct contact information.

17. Contact Sharing Protection

V1 uses a basic contact-sharing filter.

Detect obvious:

Sri Lankan phone numbers
phone numbers written as words
WhatsApp
Viber
Telegram
email addresses
social media handles

This is NOT an AI moderation system.

Do not build advanced AI moderation unless explicitly requested.

18. Reviews

Only completed paid consultations can be reviewed.

Rules:

Rating: 1-5 stars
Review text: optional
One review per consultation
Edit window: 24 hours
Astrologer response: once

Rating does NOT automatically determine refunds.

Reviews may be reported.

19. Astrologer Ranking

Ranking should consider:

Online/recent activity
Relevance to requested service
Availability
Rating
Completed consultations
Response rate
Cancellation/completion reliability

Online can initially mean:

last activity within 5 minutes

New astrologers may receive a small discovery boost during their first approximately 10 completed consultations.

Featured placement is a controlled boost.

Featured placement is NOT guaranteed to be #1.

20. Wallet / Earnings

Customer wallet is NOT part of V1.

Astrologers and referrers have internal earnings accounts.

Earnings move through:

PENDING
   |
   | 24 hours after completion
   v
AVAILABLE

Settlement hold:

24 hours

Payouts are weekly.

Payouts must reserve eligible ledger amounts before calling the external payout system.

If payout fails:

reserved -> available

Do not lose or duplicate funds.

21. Payment Gateway

The payment gateway must be abstracted.

Create an interface such as:

PaymentGateway

The business logic must NOT depend directly on one provider.

The provider can be changed later.

The architecture assumes the selected gateway can support the required payment, refund, and payout operations.

Do not hard-code provider-specific business rules into domain services.

22. Video / Audio Provider

Video/audio must also be abstracted.

Create an interface such as:

CallProvider

Business logic should not depend directly on the selected video provider.

Provider-specific implementation belongs in infrastructure/integration code.

23. Files

Use:

Cloudflare R2

Bucket must be private.

Database stores metadata only.

Do NOT store file BLOBs inside MySQL.

Use signed URLs after authorization.

Consultation files are accessible only to:

the customer
assigned astrologer
authorized Admin/dispute staff
24. Authentication

Authentication is OTP based.

User registration:

phone + OTP + name

One phone number = one account.

OTP codes must not be stored in plain text.

Store hashes where appropriate.

Implement:

expiry
retry limits
attempt limits
session management
refresh token rotation/revocation

Never commit secrets.

25. Security

Never expose private phone numbers through APIs.

Never expose private R2 object keys unnecessarily.

Validate all DTOs.

Authorize every protected resource.

Do not trust:

client-provided prices
client-provided commission amounts
client-provided user IDs
client-provided referral ownership
client-provided payment status
client-provided appointment ownership

The server calculates authoritative business values.

26. Transactions

These operations must be transactional:

appointment reservation
proposal acceptance
payment finalization
financial snapshot creation
ledger creation
refund allocation
payout reservation
referral commission creation

External API calls should generally happen outside database transactions unless there is a very specific reason.

Use idempotency and state reconciliation around external systems.

27. Background Jobs

Use BullMQ for jobs such as:

consultation request expiry
proposal expiry
payment reservation expiry
ledger availability
appointment reminders
notifications
follow-up expiry
payout processing
cleanup tasks

Jobs must be idempotent.

A job running twice must not create duplicate financial transactions or duplicate state transitions.

28. Notifications

Use:

FCM = push
Notify.lk = SMS

Important events include:

consultation request submitted
request accepted
request declined
appointment proposed
payment reminder
payment successful
appointment reminder
cancellation
refund
dispute update
consultation completed
referral earnings
payout processed

Notification sending should normally happen asynchronously after the database transaction succeeds.

29. Admin

V1 has exactly one Admin role.

Admin can:

manage users
manage astrologers
manage services
view consultations
view payments
process refunds
manage disputes
manage payouts
correct referral relationships
suspend users/astrologers
manage featured placements
manage settings
inspect audit logs

Sensitive Admin actions must create AuditLog records.

30. Audit Logs

Audit important Admin actions:

refunds
payout actions
user suspension
astrologer suspension
referral correction
financial adjustment
settings changes
dispute resolution

Where practical store:

oldData
newData
adminUserId
entityType
entityId
IP
timestamp
31. API Design

Controllers should be thin.

Business logic belongs in services/use cases.

Use:

DTOs
validation
guards
authorization
Swagger
consistent error responses

Do not put complex business logic directly inside controllers.

32. Database Rules

Use foreign keys where appropriate.

Use unique constraints for identity/business uniqueness.

Use indexes for:

foreign keys
status fields used in queues/search
appointment time queries
user phone
referral codes
payment gateway IDs
ledger references

Do not add indexes blindly.

33. Testing Requirements

Important tests include:

Financial
80/3/3/remaining split
no referral
one referral
two referrals
refunds
partial refunds
payout reservation
payout failure
duplicate webhook
Booking
overlapping appointments
adjacent appointments
buffer
concurrent booking attempts
expired reservation
concurrent proposal creation
State transitions

Test every allowed transition and reject invalid transitions.

Security
unauthorized consultation access
unauthorized file access
unauthorized Admin operations
phone number exposure
referral tampering
34. Development Style

Prefer simple, readable code.

Do not over-engineer.

Do not introduce abstractions without a reason.

Do not build features that are not required for V1.

When a business rule is ambiguous, STOP and ask before inventing a rule.

When implementing a known rule, do not silently change it.

Always check:

AGENTS.md
docs/business-rules.md
docs/state-machines.md
docs/architecture.md
docs/database.md

before making architectural changes.

35. V1 Scope Discipline

Do NOT add without explicit approval:

customer wallet
Google Calendar integration
automatic call recording
AI astrology
AI moderation
bidding marketplace
auction-based featured listings
multiple Admin roles
KYC verification system
verified badges
microservices
Kubernetes
Kafka
complex recommendation AI

Keep V1 small, reliable, auditable, and maintainable.
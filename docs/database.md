# Welapathkade — Database Design

## 1. Database

Database:

```text
MySQL

ORM:

Prisma

MySQL is the source of truth.

All important business state must be persisted in MySQL.

2. General Rules

Use:

UTC timestamps
DECIMAL monetary values
foreign keys
unique constraints
indexes where justified

Money should use:

DECIMAL(12,2)

Do not use FLOAT or DOUBLE for money.

3. User
User

id
phone UNIQUE
name
billingFirstName NULL
billingLastName NULL
billingEmail NULL
billingAddress NULL
billingCity NULL
billingCountry NULL
role
status
language
referralCode UNIQUE
referredByUserId NULL
createdAt
updatedAt

Role:

PUBLIC
ASTROLOGER
ADMIN

Status:

ACTIVE
INACTIVE
SUSPENDED

Language:

SI
EN

Relationship:

User.referredByUserId -> User.id

A user can have another public user as referrer.

Referral relationship is normally immutable.

Customer billing columns are nullable. They are filled when the customer saves a billing profile, not at registration. `billingEmail` is the payment contact email. It is separate from `email`, which remains the optional admin login address. The customer's phone number stays on `phone`.

4. UserSession
UserSession

id
userId
refreshTokenHash
deviceId
ip
userAgent
expiresAt
revokedAt
createdAt

Indexes:

userId
expiresAt
5. OtpVerification
OtpVerification

id
userId NULL
phone
purpose
codeHash
status
expiresAt
verifiedAt
attempts
createdAt

OTP must not be stored as plaintext.

Purpose examples:

REGISTRATION (legacy alias for PUBLIC_REGISTRATION)
PUBLIC_REGISTRATION
ASTROLOGER_REGISTRATION
LOGIN
PHONE_CHANGE

The OTP purpose stored on the verification row is authoritative for registration role creation.
Clients cannot set User.role directly on verify.
6. UserDevice
UserDevice

id
userId
fcmToken UNIQUE
platform
lastSeenAt
createdAt
updatedAt
7. BankAccount
BankAccount

id
userId
bankName
branchName
accountName
accountNumber
status
isPrimary
createdAt
updatedAt

Bank account data is private.

Status examples:

ACTIVE
INACTIVE
8. AstrologerProfile
AstrologerProfile

id
userId UNIQUE
displayName
bio
experienceYears
profilePhotoFileId NULL
city
district
status
createdAt
updatedAt

Status:

ACTIVE
INACTIVE
SUSPENDED

The astrologer is represented by the central User record plus this profile.

Operational profile status is separate from onboarding application status.

8b. AstrologerApplication
AstrologerApplication

id
astrologerProfileId UNIQUE
status
rejectionReason NULL
submittedAt NULL
reviewedAt NULL
reviewedByAdminId NULL
createdAt
updatedAt

Status:

DRAFT
PENDING_REVIEW
REJECTED
APPROVED

Lifecycle:

DRAFT → PENDING_REVIEW → APPROVED
DRAFT → PENDING_REVIEW → REJECTED → (edit) → PENDING_REVIEW

On APPROVE: application=APPROVED and profile.status=ACTIVE.
On REJECT: application=REJECTED and profile.status remains INACTIVE.

9. Service
Service

id
code UNIQUE

nameSi
nameEn

descriptionSi
descriptionEn

minPrice
maxPrice

status

createdAt
updatedAt

Status:

ACTIVE
INACTIVE

Service duration is NOT stored as a fixed platform duration.

The astrologer chooses duration per appointment.

10. AstrologerService
AstrologerService

id
astrologerId
serviceId
price
status
createdAt
updatedAt

Unique:

(astrologerId, serviceId)

Price is the astrologer's current configured price.

Historical consultation/appointment prices must be snapshotted separately.

11. WeeklyAvailability
WeeklyAvailability

id
astrologerId
dayOfWeek (MONDAY…SUNDAY)
startTime (local HH:mm Asia/Colombo)
endTime (local HH:mm Asia/Colombo)
createdAt
updatedAt

Example:

Monday
09:00
17:00

Multiple windows per day are allowed.

Constraints (enforced in application layer):

- startTime < endTime
- no overlapping windows for the same astrologer + day
- times are local Asia/Colombo clock values, not UTC

12. AvailabilityException
AvailabilityException

id
astrologerId
date (Asia/Colombo calendar DATE)
type
startTime NULL
endTime NULL
reason NULL
createdAt
updatedAt

Type:

UNAVAILABLE
AVAILABLE_OVERRIDE

Rules:

- UNAVAILABLE clears the date (no start/end)
- AVAILABLE_OVERRIDE replaces weekly windows for that date (requires start/end)
- exceptions must not conflict ambiguously on the same date

Used for date-specific changes to weekly availability.

13. AstrologerBookingGuard
AstrologerBookingGuard

astrologerId PRIMARY KEY
createdAt
updatedAt

Exactly one row per astrologer.

This is a synchronization primitive.

It is NOT business data.

Created when an astrologer profile is created (and backfilled by migration).

Used with:

SELECT astrologerId
FROM AstrologerBookingGuard
WHERE astrologerId = ?
FOR UPDATE;
14. Consultation
Consultation

id

customerId
astrologerId

astrologerServiceId
serviceId

requestedPrice
serviceNameSi
serviceNameEn

message

status

preferredStartAt
preferredEndAt NULL

submittedAt
viewedAt
respondedAt
expiresAt
declineReason NULL
completedAt

createdAt
updatedAt

Status:

PENDING
ACCEPTED
DECLINED
EXPIRED
CANCELLED

`preferredStartAt` is the customer's preferred time (UTC). It is **not** an appointment.

`preferredEndAt` is optional preference only — final duration is chosen by the astrologer in a later appointment proposal.

`requestedPrice` / service names are snapshotted at request time for display/audit.

Final appointment price must be snapshotted separately.

Indexes:

customerId
astrologerId
status
expiresAt
submittedAt
(astrologerId, status, submittedAt)
(customerId, status, submittedAt)
(status, expiresAt)

No unique constraint preventing multiple legitimate requests to the same astrologer.

15. File
File

id

provider
bucket
objectKey UNIQUE

originalFilename
mimeType
sizeBytes
checksum

uploadedByUserId

status

createdAt
updatedAt

Provider:

CLOUDFLARE_R2

Status:

UPLOADING
AVAILABLE
DELETED

Database stores metadata only.

16. ConsultationFile
ConsultationFile

id
consultationId
fileId
type
sortOrder
createdAt

Type:

KUNDALI
VOICE_NOTE

This allows a consultation to have multiple files.

API returns file metadata only to authorized customer/assigned astrologer.
Do not expose public URLs or unnecessary storage keys in responses.
R2 signed URL generation belongs behind the files storage abstraction (later).

17. AppointmentProposal
AppointmentProposal

id

consultationId
astrologerId
astrologerServiceId

startAt
durationMinutes
endAt

price

status
expiresAt
respondedAt

createdAt
updatedAt

Status:

PENDING
ACCEPTED
REJECTED
EXPIRED
CANCELLED

Only one PENDING proposal per consultation.

Historical proposals remain stored.

18. Appointment
Appointment

id

consultationId UNIQUE
proposalId UNIQUE

customerId
astrologerId

startAt
durationMinutes
endAt

price

status

reservationExpiresAt

confirmedAt
startedAt
endedAt
cancelledAt
completedAt

createdAt
updatedAt

Status:

PAYMENT_PENDING
CONFIRMED
PAYMENT_EXPIRED
CANCELLED_BY_CUSTOMER
CANCELLED_BY_ASTROLOGER
NO_SHOW_CUSTOMER
NO_SHOW_ASTROLOGER
TECHNICAL_FAILURE
IN_PROGRESS
COMPLETED
DISPUTED

price is immutable for the appointment.

19. Payment
Payment

id

consultationId UNIQUE
appointmentId UNIQUE

gateway
gatewayPaymentId UNIQUE NULL
gatewayReference

amount
currency

status

paidAt
failedAt
refundedAt

createdAt
updatedAt

Status:

PENDING
SUCCESS
FAILED
REFUND_PENDING
REFUNDED

Gateway IDs must support idempotency.

The implemented payment provider is `MOCK` or `PAYHERE`. `PaymentAttempt.merchantReference` is the PayHere `order_id`. `providerPaymentId` stores PayHere's `payment_id` after a verified notification or retrieval. `PayHereNotification` is unique on merchant reference, PayHere payment id, and status code. Cardholder name, masked card number, and card expiry are not stored. A full refund obligation is not a completed PayHere refund.

`PayHereRefund` is one refund attempt. `openRefundSlot` holds the payment id while the attempt is not a definitive unused failure, so a second full refund cannot start. It is cleared only after Retrieval shows the payment is still `RECEIVED`. `payhereRefundNumber` is unique and null until PayHere returns one. Status is `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, or `REQUIRES_REVIEW`. The stored provider metadata is the status, message, and refund number only.

`SavedPaymentMethod` is a customer card registration, not a consultation payment. `merchantReference` is the PayHere pre-approval `order_id` and starts with `pa_`. `openCardSlot` is the user id while the card is `PENDING` or `ACTIVE`, so a customer cannot have two usable registrations. The PayHere `customer_token` is stored only as `tokenCiphertext`, `tokenIv`, and `tokenTag` (AES-256-GCM). Those columns are nulled on revocation or removal. `cardLast4` is stored only when PayHere sends a masked card number. Cardholder name, expiry, CVV, and the plaintext token are not stored. `SavedCardConsentEvent` records `CONSENT_GRANTED`, `CONSENT_REVOKED`, and `CARD_REMOVED` with the consent version. Status moves `PENDING` to `ACTIVE` only after a verified pre-approval notification, or to `FAILED` when PayHere reports failure or cancellation. `DISABLED` is a customer revocation. `REMOVED` is a customer removal. Neither status can become `ACTIVE` again.

A saved-card consultation charge is a normal `PaymentAttempt` whose `merchantReference` starts with `sc_`. `openChargeSlot` is the payment id while that attempt is in flight, pending, or uncertain, so a second charge cannot start. `requiresReview` means the charge is not verified. A synchronous Charging API response does not clear it. It is cleared only when Retrieval returns one matching `RECEIVED` payment, or when the attempt is marked failed because the charge POST was never sent. `checkoutPayload.dispatchAuthorizedAt` is set under a row lock on the saved card after OAuth and before that POST. The plaintext `customer_token` is not stored on the attempt.

20. ConsultationFinancial
ConsultationFinancial

id
consultationId UNIQUE

grossAmount

astrologerId
astrologerPercentage
astrologerAmount

customerReferrerId NULL
customerReferralPercentage
customerReferralAmount

astrologerReferrerId NULL
astrologerReferralPercentage
astrologerReferralAmount

platformPercentage
platformAmount

createdAt

This is an immutable financial snapshot.

Example:

gross = 1000

astrologerPercentage = 80
astrologerAmount = 800

customerReferralPercentage = 3
customerReferralAmount = 30

astrologerReferralPercentage = 3
astrologerReferralAmount = 30

platformPercentage = 14
platformAmount = 140
21. LedgerAccount
LedgerAccount

id

userId NULL
type
currency

createdAt
updatedAt

Unique:

(userId, type)

Types:

ASTROLOGER_EARNINGS
REFERRAL_EARNINGS
PLATFORM
22. LedgerTransaction
LedgerTransaction

id

ledgerAccountId

type
status

amount

referenceType
referenceId

availableAt

createdAt
updatedAt

Types:

CONSULTATION_EARNING
REFERRAL_COMMISSION
PLATFORM_COMMISSION
REFUND_REVERSAL
ADJUSTMENT
PAYOUT
PAYOUT_REVERSAL

Status:

PENDING
AVAILABLE
RESERVED
REVERSED

Idempotency uniqueness should include:

type
referenceType
referenceId
ledgerAccountId

Do not delete ledger records.

23. Refund
Refund

id

paymentId
consultationId

amount
reason
status

gatewayRefundId UNIQUE NULL

createdAt
updatedAt
processedAt

Status:

PENDING
PROCESSING
SUCCESS
FAILED
24. RefundAllocation
RefundAllocation

id
refundId UNIQUE

astrologerAmount
customerReferralAmount
astrologerReferralAmount
platformAmount

createdAt

This preserves how the refund affects the original financial split.

25. Payout
Payout

id

ownerUserId
ledgerAccountId
bankAccountId

amount
currency

gateway
gatewayPayoutId UNIQUE NULL

status

failureReason

createdAt
updatedAt
processedAt

Status:

PENDING
PROCESSING
SUCCESS
FAILED
26. Dispute
Dispute

id

consultationId UNIQUE
openedByUserId

reason
description

status
resolution

resolvedByAdminId
resolvedAt

createdAt
updatedAt

Status:

OPEN
UNDER_REVIEW
RESOLVED
REJECTED

Resolution:

FULL_REFUND
PARTIAL_REFUND
NO_REFUND
RESCHEDULE
DISMISSED
27. CallSession
CallSession

id

appointmentId UNIQUE
astrologerId

provider
providerSessionId UNIQUE

status

customerJoinedAt
astrologerJoinedAt

startedAt
endedAt

customerLeftAt
astrologerLeftAt

actualDurationSeconds

createdAt
updatedAt

No recording fields are required for V1.

28. Conversation
Conversation

id

consultationId UNIQUE

status
followUpExpiresAt
customerMessageCount

createdAt
updatedAt

Status:

ACTIVE
READ_ONLY
29. Message
Message

id

conversationId
senderId

type
content

createdAt
readAt

V1 message type:

TEXT

No image/file/voice message types.

30. Review
Review

id

consultationId UNIQUE
customerId
astrologerId

rating
comment

editedAt

astrologerResponse
astrologerRespondedAt

status

createdAt
updatedAt

Rating:

1-5

Status examples:

ACTIVE
REPORTED
HIDDEN
31. FeaturedPlacement
FeaturedPlacement

id

astrologerId

startAt
endAt

amount

paymentId

status

createdAt
updatedAt

Status:

PENDING
ACTIVE
EXPIRED
CANCELLED
32. Notification
Notification

id

userId

type
title
body

channel
status

referenceType
referenceId

sentAt
readAt

createdAt

Channel:

PUSH
SMS

Status:

PENDING
SENT
FAILED
READ
33. SystemSetting
SystemSetting

id

key UNIQUE
value
valueType

updatedByAdminId

createdAt
updatedAt

Possible settings:

CONSULTATION_RESPONSE_TIMEOUT_MINUTES
PAYMENT_TIMEOUT_MINUTES
CUSTOMER_REFERRAL_PERCENTAGE
ASTROLOGER_REFERRAL_PERCENTAGE
ASTROLOGER_EARNING_PERCENTAGE
SETTLEMENT_HOLD_HOURS
APPOINTMENT_BUFFER_MINUTES
MIN_BOOKING_LEAD_MINUTES
MAX_BOOKING_HORIZON_DAYS
FOLLOW_UP_HOURS
CUSTOMER_FOLLOW_UP_MESSAGE_LIMIT
MINIMUM_PAYOUT_AMOUNT
FEATURED_7_DAY_PRICE
FEATURED_30_DAY_PRICE
34. AuditLog
AuditLog

id

adminUserId

action

entityType
entityId

oldData
newData

ip

createdAt

Used for sensitive Admin actions.

35. Entity Relationships

High-level:

User
 ├── UserSession
 ├── UserDevice
 ├── BankAccount
 ├── LedgerAccount
 ├── Notifications
 ├── Messages
 ├── Reviews
 ├── AuditLog
 │
 ├── referredByUser
 │
 ├── AstrologerProfile
 │     ├── AstrologerService
 │     ├── WeeklyAvailability
 │     ├── AvailabilityException
 │     ├── Appointment
 │     ├── AppointmentProposal
 │     └── CallSession
 │
 └── Consultation
       ├── ConsultationFile
       ├── AppointmentProposal
       ├── Appointment
       ├── Payment
       ├── ConsultationFinancial
       ├── Dispute
       ├── Conversation
       │    └── Message
       └── Review
36. Important Unique Constraints

At minimum:

User.phone
User.referralCode

AstrologerProfile.userId

Service.code

AstrologerService(astrologerId, serviceId)

AstrologerBookingGuard.astrologerId

AppointmentProposal consultation + pending business rule

Appointment.consultationId
Appointment.proposalId

Payment.consultationId
Payment.appointmentId
Payment.gatewayPaymentId

ConsultationFinancial.consultationId

LedgerAccount(userId, type)

LedgerTransaction idempotency key

Refund.gatewayRefundId

RefundAllocation.refundId

Payout.gatewayPayoutId

Dispute.consultationId

CallSession.appointmentId
CallSession.providerSessionId

Conversation.consultationId

Review.consultationId

FeaturedPlacement references as required

Some rules such as "only one pending proposal" may require application-level enforcement or an appropriate MySQL strategy rather than a simple unique constraint.

37. Important Indexes

Expected indexes include:

User.phone
User.referralCode
User.referredByUserId

UserSession.userId
UserSession.expiresAt

OtpVerification.phone
OtpVerification.expiresAt

AstrologerProfile.status

AstrologerService.astrologerId
AstrologerService.serviceId

WeeklyAvailability.astrologerId

AvailabilityException.astrologerId + date

Consultation.customerId
Consultation.astrologerId
Consultation.status
Consultation.expiresAt

AppointmentProposal.consultationId
AppointmentProposal.astrologerId
AppointmentProposal.status
AppointmentProposal.expiresAt
AppointmentProposal.startAt

Appointment.astrologerId
Appointment.customerId
Appointment.status
Appointment.startAt
Appointment.reservationExpiresAt

Payment.status
Payment.gatewayPaymentId

LedgerTransaction.ledgerAccountId
LedgerTransaction.status
LedgerTransaction.availableAt
LedgerTransaction.referenceType + referenceId

Payout.ownerUserId
Payout.status

Dispute.status

Message.conversationId
Message.createdAt

Review.astrologerId
Review.rating

FeaturedPlacement.astrologerId
FeaturedPlacement.startAt
FeaturedPlacement.endAt

Notification.userId
Notification.status

Indexes should be validated against actual query patterns.

38. Booking Conflict Query

Overlap:

existing.start_at < requested_end
AND existing.end_at > requested_start

When checking availability, account for:

10-minute scheduling buffer

Example:

Existing appointment:
15:00 - 16:00

Buffer:
10 minutes

Next valid start:
16:10

Do not change the stored appointment end time to include the buffer.

39. Booking Transaction

Use:

BEGIN;

SELECT astrologer_id
FROM astrologer_booking_guards
WHERE astrologer_id = ?
FOR UPDATE;

Then:

validate consultation
validate proposal
validate availability
check conflicts
create reservation
commit

Use Prisma interactive transactions plus raw SQL for the locking query.

40. Financial Integrity

At completion:

ConsultationFinancial
        ↓
LedgerTransaction(s)

Expected transactions:

Astrologer earning
Customer referral earning if applicable
Astrologer referral earning if applicable
Platform commission

Every transaction must be idempotent.

41. Historical Data

Historical records must preserve:

price
commission percentage
commission amount
referrer IDs
appointment duration
appointment time
payment amount

Changing today's settings must not rewrite historical financial facts.

42. Deletion Policy

Do not hard-delete important financial/history records.

Prefer:

status

or:

deletedAt

where appropriate.

Especially do not delete:

payments
refunds
ledger transactions
payouts
consultations with financial history
audit logs
43. Prisma Implementation Notes

Use Prisma models and enums for stable domain states.

Use Decimal for monetary fields.

Use DateTime for timestamps.

Use nullable foreign keys where relationships are optional.

Use explicit relation names when multiple relationships exist between User and another model.

For booking locking, Prisma may require:

$executeRaw

or:

$queryRaw

inside an interactive transaction.

Do not bypass transactions for booking integrity.

44. Database Evolution

All schema changes must be made through Prisma migrations.

Do not manually modify production tables as a normal development practice.

Before applying destructive migrations:

verify affected data
create backup
review migration
test locally
test against staging if available
45. Source of Truth

The database remains authoritative for:

users
consultations
appointments
payments
financials
ledger
refunds
payouts
disputes
reviews
availability
referrals

Redis must never become the only copy of important business state.
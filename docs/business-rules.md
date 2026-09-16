# Welapathkade — Business Rules

## 1. Overview

Welapathkade is an astrology consultation marketplace.

The marketplace connects:

- Customers/public users
- Astrologers
- Platform Admin

Supported languages:

- Sinhala
- English

Business timezone:

```text
Asia/Colombo

Database timestamps:

UTC
2. User Accounts
2.1 Public User

A public user can:

register with phone number
request consultations
make payments
attend consultations
send follow-up messages
review astrologers
refer other public users
refer astrologers
earn referral commissions
2.2 Astrologer

An astrologer can:

register using OTP
create profile
select services
set service prices
define availability
receive consultation requests
accept/decline requests
propose appointment times
conduct consultations
reply to follow-up messages
receive earnings
receive referral earnings
receive payouts
2.3 Admin

V1 has one Admin role.

Admin can manage the platform and perform controlled financial/operational actions.

3. Phone Number Rules

One phone number can belong to only one account.

Phone numbers must be unique.

Phone numbers are private and must not be exposed to other users.

4. Referral System
4.1 Referral Types

There are two referral relationships:

Customer referral

Public User A refers Public User B.

A receives:

3%

of eligible completed consultations made by B.

This is lifetime.

Astrologer referral

Public User A refers Astrologer B.

A receives:

3%

of eligible completed consultations performed by B.

This is lifetime.

4.2 Multiple Referrals

A consultation may have:

customer referrer
+
astrologer referrer

Both commissions can apply.

Example:

Gross consultation = Rs.1000

Astrologer = Rs.800
Customer referrer = Rs.30
Astrologer referrer = Rs.30
Platform = Rs.140

Total:

100%
5. Referral Ownership

Referral ownership is established at registration/onboarding.

Normal users cannot change their referrer.

Only Admin can correct a referral relationship.

Admin correction requires an audit log.

Referral ownership used for a financial transaction must be snapshotted.

Historical financial transactions must not change when referral configuration changes.

6. Consultation Request

The customer selects:

astrologer
service

The customer submits:

message
optional kundali files/images
optional voice note
preferred times

Payment is NOT required at request submission.

7. Astrologer Response SLA

Astrologer response deadline:

12 hours

Allowed responses:

ACCEPT
DECLINE

If the astrologer does not respond:

EXPIRED

Viewing the request does not reset or stop the timer.

8. Appointment Proposal

After acceptance, astrologer proposes:

date
start time
duration
end time
price

Only one proposal can be pending at a time.

The astrologer chooses the appointment duration.

Service catalog does NOT contain a mandatory fixed duration.

9. Proposal Response

Customer can:

ACCEPT
REJECT

If rejected:

proposal becomes historical
astrologer may propose another time

The platform does not automatically select a replacement time.

10. Payment

After customer accepts a proposal:

Appointment = PAYMENT_PENDING

Payment deadline:

30 minutes

The reserved slot remains blocked during this period.

If payment is not completed:

PAYMENT_EXPIRED

Slot becomes available.

11. Payment Confirmation

The backend is authoritative.

Flutter must not directly determine payment success.

Payment success should be confirmed using the payment gateway server-side notification/webhook.

Payment webhook handling must be idempotent.

A duplicate webhook must not:

create another payment
create another appointment
create duplicate ledger transactions
create duplicate referral commissions
12. Appointment Availability

Minimum lead time:

1 hour

Maximum booking horizon:

30 days

Scheduling interval:

30 minutes

Buffer:

10 minutes

The buffer applies to scheduling availability.

It does not change the appointment's billed duration.

13. Double Booking

Appointments may have variable duration.

Overlap:

existing.startAt < requested.endAt
AND
existing.endAt > requested.startAt

A booking must be rejected if another blocking appointment/proposal overlaps it.

Blocking states include valid:

payment-pending reservations
confirmed appointments
active sessions
disputed appointments where the time remains occupied

Expired reservations do not block availability.

14. Customer Cancellation

Customer can cancel at any time before the appointment.

Even:

5 minutes before

receives:

100% refund
15. Astrologer Cancellation

If astrologer cancels:

100% refund to customer

The astrologer's reliability metrics may be negatively affected.

16. No Show

No-show states are recorded separately.

Admin may review:

appointment
join times
session duration
technical events
relevant communication

before deciding a dispute/refund.

17. Technical Failure

If video fails but audio works:

Switch to in-app audio.

Technical failure does not automatically mean full refund.

Admin can resolve technical disputes.

18. Session

Normal lifecycle:

CONFIRMED
    ↓
IN_PROGRESS
    ↓
COMPLETED

Store:

scheduled start
actual start
actual end
customer joined
astrologer joined
leave timestamps
actual duration

No automatic audio/video recording in V1.

19. Follow-Up

Follow-up period:

48 hours after completion

Customer:

maximum 5 messages

Astrologer:

unlimited replies

After expiry:

read-only
20. Chat Restrictions

Follow-up chat supports:

TEXT only

Not supported:

image
file
voice message
video call
direct phone call

No phone numbers or direct contact details should be exposed.

21. Contact Sharing Filter

Detect obvious attempts to share:

Sri Lankan phone numbers
spelled-out phone numbers
WhatsApp
Viber
Telegram
email addresses
social media handles

V1 uses simple deterministic filtering.

No AI moderation is required.

22. Reviews

Only completed paid consultations can receive reviews.

Rules:

Rating: 1-5
Comment: optional
One review per consultation
Edit window: 24 hours
Astrologer response: once

Reviews may be reported.

A rating does not automatically trigger a refund.

23. Ranking

Ranking factors:

online/recent activity
service relevance
availability
rating
completed consultations
response rate
cancellation/completion reliability

Online threshold:

last activity <= 5 minutes

New astrologers may receive discovery exposure during approximately their first 10 completed consultations.

Featured placement provides a controlled ranking boost.

It does not guarantee first position.

24. Astrologer Earnings

For each eligible completed consultation:

Astrologer = 80%

Customer referral:

3% if applicable

Astrologer referral:

3% if applicable

Platform receives the remainder.

25. Financial Examples
No referrals

Rs.1000:

Astrologer = Rs.800
Platform = Rs.200
Customer referral only
Astrologer = Rs.800
Customer referrer = Rs.30
Platform = Rs.170
Astrologer referral only
Astrologer = Rs.800
Astrologer referrer = Rs.30
Platform = Rs.170
Both referrals
Astrologer = Rs.800
Customer referrer = Rs.30
Astrologer referrer = Rs.30
Platform = Rs.140
26. Financial Snapshot

At consultation completion, store:

gross amount
astrologer percentage
astrologer amount
customer referrer
customer referral percentage
customer referral amount
astrologer referrer
astrologer referral percentage
astrologer referral amount
platform percentage
platform amount

This snapshot is immutable.

27. Settlement

After completion:

Earnings = PENDING

Settlement hold:

24 hours

Then:

AVAILABLE

provided there is no blocking dispute/refund.

28. Payout

Payout frequency:

Weekly

Payouts are made through the configured payment gateway.

Astrologer and referrer bank details are stored separately.

Customer does not have a wallet in V1.

29. Refund

Refunds must be represented as financial transactions.

Never directly modify an account balance.

Refunds can be:

full
partial

depending on the Admin/dispute outcome.

Original consultation financial allocation must remain available so refund allocations can be calculated correctly.

30. Disputes

Normal dispute window:

24 hours after consultation

Payment/refund operational issues may be handled for up to:

7 days

Dispute outcomes:

FULL_REFUND
PARTIAL_REFUND
NO_REFUND
RESCHEDULE
DISMISSED

Customer dissatisfaction with an astrology opinion/result is not automatically refundable.

31. Featured Astrologers

Featured placement is time-based.

Example:

7 days
30 days

Admin controls pricing.

Recommended V1 eligibility:

5 completed consultations

No auction or bidding.

32. Notifications

Important events may generate:

push notification
SMS

Push:

FCM

SMS:

Notify.lk

Appointment reminder:

approximately 10 minutes before appointment
33. Privacy

Consultation documents are private.

Accessible by:

customer
assigned astrologer
authorized Admin/dispute staff

Storage:

private Cloudflare R2 bucket

Access:

signed URLs after authorization
34. Localization

Supported:

Sinhala
English

User selects language on first launch.

Language preference is stored.

Service names/descriptions must support both languages.

35. V1 Exclusions

Do not implement unless explicitly requested:

customer wallet
Google Calendar
automatic recording
AI astrology
AI moderation
advanced recommendation engine
bidding
auction featured ads
KYC verification
verified badges
multiple Admin roles
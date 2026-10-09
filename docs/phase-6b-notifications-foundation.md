# Phase 6B — Notification foundation

Backend-only groundwork for push notifications. Reference design:
`docs/phase-6-notifications-plan.md`.

## What exists

- `Notification` model + `NotificationType` enum (Prisma + migration
  `20261009120000_phase6b_notifications`).
- `src/notifications/`:
  - `NotificationService.create(input, tx?)` persists one row and returns
    `CREATED`, `DUPLICATE` (existing row) or `DUPLICATE_UNREADABLE` (the key
    already exists but the row is not visible to this transaction's snapshot;
    treat as "already recorded", deliver nothing). Pass the caller's Prisma
    transaction client to commit atomically with a business change. It never
    opens its own transaction; unrelated database errors propagate.
  - `NotificationService.deliver(id)` attempts a push to all of the
    recipient's devices. Never throws.
  - `FCM_PROVIDER` token + `FcmProvider` contract, with `ConsoleFcmProvider`
    and `NoopFcmProvider`.

Nothing calls the service yet: no business flow, device API or logout change
was touched.

## Schema notes

- Unique `(userId, type, referenceId)` is the duplicate-event guard.
  Callers never supply `referenceId`: the service derives it from the typed
  event input — consultation id (CONSULTATION_*), proposal id (PROPOSAL_*)
  or appointment id (APPOINTMENT_CONFIRMED). The required id is enforced and
  contradictory ids are rejected before any query. `consultationId` stays in
  `data` as the navigation target, so several proposals of one consultation
  each notify separately.
- `data` holds routing ids only (`type`, `consultationId`, `proposalId`,
  `appointmentId`). `title`/`body` are generic text; never put consultation
  content, names, amounts or reasons in them.
- `sentAt`: set only when a provider accepted at least one device send.
  `attempts`: number of delivery runs that really tried a send.
  A row existing does **not** mean the user was notified.
- `User` FK is `ON DELETE RESTRICT`, so a user with notification history
  cannot be hard-deleted silently. Existing `E2E` cleanup deletes users and
  must delete notifications first once rows exist (Phase 6C).

## Provider selection

`NOTIFICATIONS_FCM_PROVIDER` (optional): `console` | `noop`. The value is
trimmed and lower-cased; empty/whitespace means unset. Any other value fails
startup validation.
Default: `console` when `NODE_ENV=development`, otherwise `noop`. No Firebase
credentials are read and no network call is made. Both providers report
`SKIPPED`, never `SENT`.

## Calling pattern for Phase 6C

```ts
const { notificationIds } = await this.prisma.$transaction(async (tx) => {
  // 1. business write
  // 2. const r = await this.notifications.create({...}, tx)  // same tx
  //    deliver only when r.status === 'CREATED' (keep r.notification.id)
});
// 3. after commit, outside any lock/transaction, not awaited by the request:
void this.notifications.deliver(id);
```

Never call `deliver` inside `withAstrologerLock` or another transaction.

## Limits

- No real FCM delivery and no `firebase-admin` yet.
- No retry worker. `sentAt`/`attempts` only record what happened; a process
  crash between commit and `deliver` leaves an unsent row that nothing
  retries automatically.
- Device registration and logout are unchanged (hardening is Phase 6D).

## Tests

```
npx jest src/notifications
```

Unit tests only (mocked Prisma and providers); no database needed.

## Applying the migration later (not done in 6B)

Review `prisma/migrations/20261009120000_phase6b_notifications/migration.sql`,
then per environment:

```
npm run prisma:migrate:deploy      # development database
npm run test:e2e:migrate           # test database
```

Never `migrate reset` or `db push`.

---

# Phase 6C: business events

The seven V1 events are now recorded by the business services. Persistence
happens inside the same database transaction as the state change; delivery
is started only after that transaction has committed.

## Events, recipients and references

| Event | Written in | Recipient (user id) | `referenceId` |
|---|---|---|---|
| `CONSULTATION_REQUESTED` | `ConsultationsService.create` (its `$transaction`) | astrologer: `profile.userId` | consultation id |
| `CONSULTATION_ACCEPTED` | `ConsultationsService.accept` (now a `$transaction`) | customer: `consultation.customerId` | consultation id |
| `CONSULTATION_DECLINED` | `ConsultationsService.decline` (now a `$transaction`) | customer | consultation id |
| `PROPOSAL_CREATED` | `createForAstrologer`, inside `withAstrologerLock` | customer: `consultation.customerId` | new proposal id |
| `PROPOSAL_ACCEPTED` | `acceptForCustomer`, inside `withAstrologerLock` | astrologer: resolved from `AstrologerProfile.userId` | proposal id |
| `PROPOSAL_REJECTED` | `rejectForCustomer` (now a `$transaction`) | astrologer (as above) | proposal id |
| `APPOINTMENT_CONFIRMED` | `PaymentsService.finalizeVerified`, inside `withAstrologerLock` | customer **and** astrologer (two rows) | appointment id |

- Accept, decline and reject create a row only when the guarded `updateMany`
  changed exactly one row. A lost guard throws/returns as before and records
  nothing.
- `APPOINTMENT_CONFIRMED` is recorded only in the branch where the guarded
  `PAYMENT_PENDING -> CONFIRMED` update changed one row. Repeated callbacks,
  `alreadyPaid`, failed/expired payments and lost races create nothing. The
  mock callback and `syncForCustomer` both reach this point.
- Astrologer recipients are resolved through `AstrologerProfile.userId`;
  consultations/proposals/appointments store the profile id, never the user id.
- `consultationId` stays in the payload as the navigation target.

## Text and language

`src/notifications/notification.templates.ts` holds plain per-type EN/SI
title and body data (no logic, no interpolation), shaped so it can later move
to database-managed translations. The language is the recipient's
`User.language`; anything other than `EN` (missing, unknown) renders Sinhala.
Texts contain no names, services, messages, decline reasons, times or amounts.
`PROPOSAL_ACCEPTED` says the time was accepted and payment is still pending;
only `APPOINTMENT_CONFIRMED` speaks of a confirmed appointment.

## Calling pattern (as implemented)

```ts
const result = await prisma.$transaction(async (tx) => {
  // business write...
  const id = await notifications.notifyUser(tx, userId, ref /*, language?*/);
  // or notifications.notifyAstrologerProfile(tx, astrologerProfileId, ref)
  return { ..., notificationId: id };
});
notifications.deliverAfterCommit([result.notificationId]); // not awaited
```

- `notifyUser` returns an id only for a newly created row (`null` for
  duplicates). It tolerates exactly one failure, `InvalidNotificationError`
  (logged safely, business operation continues). Database, foreign-key,
  deadlock and any other error propagate and roll the transaction back.
- `deliverAfterCommit` ignores null ids, never blocks and never rejects.
  Delivery failures cannot undo the committed business change.
- In-flight deliveries are tracked; `flushPending()` resolves when they have
  settled. `onModuleDestroy` awaits them before Prisma disconnects (verified in
  `notification.lifecycle.spec.ts`). E2E specs also call `flushPending()`
  explicitly before cleanup and shutdown.

## Limits (V1)

- No automatic retry and no durable outbox: an unsent row (provider down,
  process crash between commit and delivery) is not retried.
- `sentAt` is set when any device send is accepted; devices that failed in the
  same run are not retried individually.
- No real FCM delivery yet; the provider is console (development) or no-op.

## Tests

```
npx jest                      # all unit tests
npm run test:e2e              # guarded; refuses anything but welapathkade_test
```

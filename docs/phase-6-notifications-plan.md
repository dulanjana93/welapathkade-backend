# Phase 6 Implementation Plan — Firebase Push Notifications

**Status:** Planning only. Not implemented.

**Inspection date:** 2026-09-28

**Scope of inspection:** `welapathkade-api`, `welapathkade_app`, `welapathkade-admin` as they exist after Phase 5B (reservation + mock payment + confirmed appointment).

Legend used throughout:

- **CURRENT** — what the repository actually does today
- **PROPOSED** — what Phase 6 should add/change
- **DECISION NEEDED** — must be approved before implementation

This plan is based on the **implemented** Phase 5B code, not on unimplemented future tables in `docs/database.md`.

Do not treat `docs/architecture.md` BullMQ/FCM sketches, or `docs/database.md` §32 `Notification`, as existing code.

---

## 1. Current notification / FCM architecture

### 1.1 Backend send path

**CURRENT — there is no FCM send path.**

| Check | Result |
|---|---|
| `firebase` / `firebase-admin` in `package.json` | Absent |
| Nest module for notifications | Absent (`AppModule` has Auth, Consultations, Payments, … — no Notifications module) |
| Business services calling FCM | None |
| Env vars for Firebase / FCM | None in `.env.example`, `.env.test.example`, or `EnvironmentVariables` |
| BullMQ / job workers | **Not in the running stack.** Mentioned in `docs/architecture.md` and `AGENTS.md` only. Redis is used for OTP rate limits and health. |

The closest existing integration pattern is **SMS OTP**:

```
OtpService / AuthService
    ↓
SMS_SENDER (Symbol)
    ↓
ConsoleSmsSender  (logs to Nest logger; stores last code for tests)
```

Payment follows the same injection style:

```
PaymentsService
    ↓
PAYMENT_GATEWAY (Symbol)
    ↓
MockPaymentGateway
```

`docs/architecture.md` §17 describes:

```text
Database transaction → commit → Create/queue notification job → BullMQ → FCM / Notify.lk
```

That flow is **aspirational**. It is not implemented. Phase 5B explicitly did **not** introduce BullMQ for reservation expiry (check-on-read instead).

### 1.2 Conceptual docs vs schema

**CURRENT — `docs/database.md` §32 sketches a `Notification` table** with `channel` (`PUSH` / `SMS`), `status` (`PENDING` / `SENT` / `FAILED` / `READ`), `referenceType` / `referenceId`, `sentAt`, `readAt`.

**CURRENT — Prisma does not have a `Notification` model.** Schema header is “Phase 1–5B”. No `NotificationType` enum.

**CURRENT — `docs/business-rules.md` §32** mentions FCM, Notify.lk SMS, and a ~10-minute appointment reminder. None of those are implemented. Appointment reminders are **out of Phase 6 scope**.

### 1.3 Admin

**CURRENT — `welapathkade-admin` has no notification UI and no FCM usage.** Out of scope (see §5).

---

## 2. Current UserDevice implementation

### 2.1 Prisma model (Phase 1, still current)

```prisma
enum DevicePlatform {
  IOS
  ANDROID
  WEB
}

model UserDevice {
  id         String         @id @default(cuid())
  userId     String
  fcmToken   String         @unique
  platform   DevicePlatform
  lastSeenAt DateTime       @default(now())
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  user User @relation(..., onDelete: Cascade)

  @@index([userId])
}
```

**CURRENT facts:**

| Topic | Behavior |
|---|---|
| One user → multiple devices | **Yes.** Only `userId` is indexed, not unique. Multiple rows per user are allowed. |
| One FCM token → one device row | **Yes.** `fcmToken` is globally `@unique`. |
| Device ID on `UserDevice` | **None.** `UserSession.deviceId` is a separate optional string; it is not linked to `UserDevice`. |
| Inactive / revoked flag | **None.** Presence of the row means “eligible to receive”. |
| WEB platform | Enum exists; Flutter never sends `WEB`. |

### 2.2 Device registration API

**CURRENT — `POST /auth/devices`** (`AuthController.registerDevice`):

- Guard: `JwtAuthGuard` only (any authenticated role: PUBLIC, ASTROLOGER, ADMIN).
- Body: `RegisterDeviceDto` — `fcmToken` (required, max 512), `platform` (`IOS` \| `ANDROID` \| `WEB`).
- Implementation: `AuthService.upsertDevice` — Prisma `upsert` **where `fcmToken`**.
  - **Create:** bind token to current `userId`.
  - **Update:** reassign `userId` + `platform` + bump `lastSeenAt`.
- Effect: if the same physical token was previously owned by another user (shared phone / re-login), ownership **moves** to the caller. That is the correct uniqueness model.

**CURRENT — `POST /auth/otp/verify`:** optional `fcmToken` + `platform`. If both are present, `verifyOtp` calls the same `upsertDevice` after issuing tokens.

**CURRENT — no `DELETE /auth/devices`.** No unregister-by-token endpoint.

### 2.3 Logout

**CURRENT — `POST /auth/logout`:** revokes the refresh-token **session only**. It does **not** delete or deactivate `UserDevice` rows.

Consequence: after logout, the previous user’s FCM token **remains registered**. A later login as a different user will reassign the token only if that client calls `POST /auth/devices` (or verify-OTP with token). Until then, pushes still target the logged-out user.

### 2.4 Tests

**CURRENT — no unit or E2E coverage of `POST /auth/devices`.** `test/auth.e2e-spec.ts` does not hit devices. `AuthService.upsertDevice` is untested. E2E cleanup already `deleteMany`s `userDevice` (FK order is correct).

---

## 3. Current Flutter Firebase implementation

### 3.1 Dependencies

**CURRENT — `pubspec.yaml` does not include `firebase_core` or `firebase_messaging`.** Also absent: `flutter_local_notifications`, `firebase_analytics`, any FCM helper.

The earlier belief that Flutter already depends on Firebase is **incorrect**.

### 3.2 Initialization and config files

| Artifact | CURRENT |
|---|---|
| `Firebase.initializeApp` | Not called (`lib/main.dart` only initializes storage, Dio, Provider, `GoRouter`) |
| Background message handler | None |
| `google-services.json` | **Missing** |
| `GoogleService-Info.plist` | **Missing** |
| Android Google Services Gradle plugin | **Not applied** (`android/settings.gradle.kts` has Android/Kotlin/Flutter plugins only; `android/app/build.gradle.kts` has no `com.google.gms.google-services`) |
| iOS Push / APNs capability | **None.** No `*.entitlements` under `ios/`. `Info.plist` has no `UIBackgroundModes` / `remote-notification`. |
| Android notification permission | Manifest has `INTERNET` only. No `POST_NOTIFICATIONS`. No default FCM notification channel. |
| `MainActivity` launchMode | Already `singleTop` (good for notification taps; not FCM-specific) |

### 3.3 Token registration from the app

**CURRENT — `AuthRepository.registerDevice({ fcmToken, platform })` exists** and POSTs `/auth/devices`.

**CURRENT — `AuthController` never calls it.** `verifyOtp` does not send `fcmToken` / `platform`. `logout` does not unregister a token. There is no token-refresh listener.

`test/auth_controller_test.dart` FakeAuthRepository stubs `registerDevice` as a no-op; no test asserts it is invoked.

### 3.4 Message handling and deep links

**CURRENT — none of:** permission prompts, foreground listeners, background/terminated handlers, notification-tap routing, Android channels.

**CURRENT routing** (`lib/core/routing/app_router.dart`) — relevant destinations already exist as **in-app paths**, not URI schemes / universal links:

| Role | Path | Screen |
|---|---|---|
| Customer | `/consultations/:id` | `ConsultationDetailScreen` |
| Customer | `/consultations/:id/pay` | Checkout (needs session extra) |
| Customer | `/consultations/:id/confirmed` | Post-pay celebration |
| Astrologer | `/astrologer/consultations/:id` | `AstrologerConsultationDetailScreen` |
| Astrologer | `/astrologer/consultations` | List |

There is **no custom URL scheme**, App Links, or Universal Links. Notification navigation must use `GoRouter` (`context.go` / `router.go`) with those paths.

Foreground UX today is **SnackBar for errors**, not an in-app notification banner system.

---

## 4. Phase 6 goals

**PROPOSED — transactional push for the live consultation → proposal → Confirm & Pay → confirmed appointment flow**, so the *other* party is notified without polling the app.

V1 goals:

1. Persist an in-app notification row per recipient per business event (idempotent).
2. Deliver that row over FCM to all registered devices for that user (best-effort, after commit).
3. Register, refresh, and (on logout) unregister FCM tokens from Flutter.
4. On notification tap (foreground / background / terminated), open the correct consultation detail for that role.
5. Mock FCM in unit and E2E tests; never call real Firebase from CI.

---

## 5. Phase 6 non-goals

Do **not** include in Phase 6:

- SMS / Notify.lk / email / WhatsApp
- FCM topic broadcasts / marketing / campaigns
- Admin notification UI (`welapathkade-admin`)
- Per-type notification preferences UI
- Scheduled notifications (including the ~10-minute appointment reminder in `business-rules.md`)
- BullMQ / workers (unless a later phase adds a scheduler; V1 does not need it for the recommended type set)
- Live PayHere (keep `MockPaymentGateway`)
- Referral, wallet, payout, ledger notifications
- Consultation 12h SLA expiry push (`CONSULTATION` `EXPIRED` is still check-on-read)
- Proposal `SUPERSEDED` push (internal replace; customer already gets `PROPOSAL_CREATED` for the new row)
- Customer-cancel-while-PENDING push
- In-app notification inbox screen (persist for reliability; Flutter V1 is tap-to-detail, not a dedicated inbox)
- Weakening `assertTestDatabase()` / using `prisma migrate reset`, `DROP DATABASE`, `docker compose down -v`, or truncating `welapathkade`

---

## 6. Recommended notification types

**PROPOSED — Prisma + shared string enum.** Names are the FCM `data.type` contract. Flutter must treat them as stable.

| Type | Recipient | Trigger | Why in V1 |
|---|---|---|---|
| `CONSULTATION_REQUESTED` | Astrologer (`AstrologerProfile.userId`) | Customer `POST /consultations` succeeds | Astrologer otherwise only sees new work by opening the app |
| `CONSULTATION_ACCEPTED` | Customer | Astrologer `POST .../accept` | Customer is waiting asynchronously |
| `CONSULTATION_DECLINED` | Customer | Astrologer `POST .../decline` | Terminal for the request; customer must be told |
| `PROPOSAL_CREATED` | Customer | Astrologer creates a proposal | Customer must accept/reject a time |
| `PROPOSAL_ACCEPTED` | Astrologer | Customer accepts proposal | Astrologer is waiting; next step is customer Confirm & Pay |
| `PROPOSAL_REJECTED` | Astrologer | Customer rejects proposal | Candidate list put this on the **customer**; that is wrong — the customer performed the action. Notify the **astrologer**. |
| `APPOINTMENT_CONFIRMED` | **Both** customer and astrologer | Payment finalize → appointment `CONFIRMED` / payment `PAID` | True booking; mock (and future PayHere notify) can complete while the other party is not in the app |

**PROPOSED — skip in V1:**

| Candidate | Reason |
|---|---|
| `PAYMENT_EXPIRED` | Reservation expiry is **check-on-read** inside `OccupancyService.expireDueReservations` (often nested in another transaction). There is no 30-minute job. A push cannot be timely without a scheduler. Sending from occupancy would surprise unrelated users whose slot query flipped someone else’s hold, and is hard to do *after* commit. See §31. |
| Actor’s own actions | Do not notify the user who just tapped Accept/Decline/Propose/Pay in the same session. Exception: `APPOINTMENT_CONFIRMED` for the **customer** is still useful because payment confirmation can be a **server callback** (`POST /payments/callbacks/mock`), not only the in-app button. |

**CURRENT — Flutter/backend do not define these strings anywhere.**

Copy used in FCM title/body should be **server-rendered** from `User.language` (`SI` / `EN`), not from client-supplied text. Keep copy short; no decline reason, no phone numbers, no amounts in the payload (amounts may appear in **localized body text** on the server if product wants “Appointment confirmed” without figures — **PROPOSED:** no amounts in title/body either for V1).

---

## 7. Notification persistence decision

### 7.1 Option A — FCM-only

Send FCM from the service after the business update. No `Notification` row.

- Pros: fewer tables, faster to ship.
- Cons: no inbox later; duplicate PayHere/mock callbacks send duplicate pushes; FCM failure is invisible; cannot prove “this event was notified” in tests without mocking send and hoping; terminated users who disable notifications have no record.

### 7.2 Option B — Persistent row + FCM delivery

Create a `Notification` row as part of the business transaction, commit, then send FCM. Unique constraint prevents duplicates. FCM failure does not roll back payment/consultation.

### 7.3 Recommendation

**PROPOSED — B for V1.**

Reasons grounded in this codebase:

1. **Payment finalize is already idempotent** (`updateMany` on `PAYMENT_PENDING`; second mock callback returns the existing `CONFIRMED` appointment). FCM-only would still fire twice unless send is gated on “this request flipped the row”. A unique notification row is the durable gate.
2. **Architecture rule:** “Business state must not roll back because FCM failed.” Persistence separates the two.
3. **`docs/database.md` already intended a Notification table** — but V1 should **not** copy its SMS `channel` / multi-status machine verbatim (see §11).
4. Flutter V1 does **not** need an inbox UI; persistence is for **idempotency, audit, and a later inbox**, not for a new tab in this phase.

**Do not** implement `docs/database.md` `channel=SMS` or BullMQ `PENDING→SENT` workers in V1.

---

## 8. Device / token lifecycle

### 8.1 CURRENT (recap)

- Upsert by `fcmToken` (global unique).
- Multi-device per user via `userId` index.
- Logout leaves tokens in place.
- Flutter never registers.

### 8.2 PROPOSED lifecycle

| Event | Behavior |
|---|---|
| App authenticated + permission granted | Read FCM token → `POST /auth/devices` |
| FCM `onTokenRefresh` | Same upsert |
| User A logs out on this phone | **Delete this token** (`DELETE /auth/devices` with body `{ fcmToken }`) **before** clearing local session, best-effort. Prevents user A receiving pushes after logout. |
| User B logs in on same phone | Upsert reassigns token to B (unique `fcmToken`) |
| Token invalid / unregistered (FCM error) | Delete that `UserDevice` row; do not fail the HTTP business API |
| Multiple devices | Fan-out FCM to **all** tokens for `userId` |
| Stale devices | V1: no `lastSeenAt` sweeper. Invalid-token deletes handle the important case. Optional later: deactivate if `lastSeenAt` older than N days. |
| Duplicate register | Idempotent upsert; bump `lastSeenAt` |

### 8.3 Recommended constraints / indexes (no migration yet)

**CURRENT already has:** `UNIQUE(fcmToken)`, `INDEX(userId)`.

**PROPOSED additions:** none strictly required for V1 send path. Optional: `INDEX(lastSeenAt)` only if a later sweeper is added — **not** in V1.

**PROPOSED — `fcmToken` length:** DTO max is 512; Prisma `VARCHAR(191)` via default. Typical FCM tokens are well under 191. Keep 191 unless a real token is rejected; then widen in a follow-up migration.

**PROPOSED — still no `deviceId` on `UserDevice`.** Session `deviceId` is not a reliable FCM key. Token *is* the device identity for push.

**DECISION NEEDED — logout unregister:** recommended **yes**. Without it, shared-device privacy is weak.

---

## 9. Notification service architecture

**PROPOSED — mirror `SMS_SENDER` / `PAYMENT_GATEWAY`, not a direct Firebase import in domain services.**

```text
ConsultationsService / ConsultationProposalsService / PaymentsService
        ↓  (after successful business write)
NotificationService.enqueueForUsers(...)   // create rows in current tx OR after commit — see §21
        ↓
commit
        ↓
NotificationService.deliver(notificationIds)  // never throws to caller
        ↓
FCM_PROVIDER.send(...)
        ↓
Firebase Admin (prod)  |  ConsoleFcmProvider (dev)  |  Noop / mock (test)
```

**PROPOSED module layout:**

- `src/notifications/notifications.module.ts` — `@Global()` **or** imported by `ConsultationsModule` + `PaymentsModule` + `AuthModule` (auth only if device delete stays in Auth).
- `NotificationService` — create + load devices + call provider + handle invalid tokens.
- **Do not** import Firebase types into `ConsultationsService` / `PaymentsService`.
- **Do not** call FCM from `OccupancyService` (nested in other transactions; expiry is a side effect of reads).

Copy/title helpers live in the notifications module (SI/EN templates keyed by `NotificationType`), not in Flutter and not in Prisma.

**PROPOSED — `NotificationsModule` does not import Consultations/Payments** (avoid cycles). Consultations/Payments import Notifications.

---

## 10. FCM provider abstraction

**PROPOSED:**

```ts
export const FCM_PROVIDER = Symbol('FCM_PROVIDER');

export type FcmSendInput = {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>; // FCM data values must be strings
};

export type FcmSendResult =
  | { ok: true }
  | { ok: false; invalidToken: boolean; error: string };

export interface FcmProvider {
  send(input: FcmSendInput): Promise<FcmSendResult>;
}
```

| Environment | Implementation |
|---|---|
| `NODE_ENV=test` / E2E | `NoopFcmProvider` or Jest mock — records calls, never networks |
| Development without credentials | `ConsoleFcmProvider` (log title/type/userId/token suffix) — same idea as `ConsoleSmsSender` |
| Production / staging with credentials | `FirebaseAdminFcmProvider` using Firebase Admin `messaging().send` |

**PROPOSED — credentials optional at process boot.** If Admin SDK cannot initialize, bind Console/Noop and log a warning. Do **not** crash Nest the way a missing `DATABASE_URL` does. Push is best-effort; API must still accept consultations.

**CURRENT — `EnvironmentVariables` has no optional Firebase fields.** Adding optional strings is required for production; tests keep working with them unset.

---

## 11. Database changes

**PROPOSED — new enum + model. Do not implement `docs/database.md` §32 as-is** (no SMS channel, no `PENDING/SENT/FAILED/READ` delivery state machine in V1).

```prisma
enum NotificationType {
  CONSULTATION_REQUESTED
  CONSULTATION_ACCEPTED
  CONSULTATION_DECLINED
  PROPOSAL_CREATED
  PROPOSAL_ACCEPTED
  PROPOSAL_REJECTED
  APPOINTMENT_CONFIRMED
}

model Notification {
  id             String           @id @default(cuid())
  userId         String
  type           NotificationType
  title          String           @db.VarChar(160)
  body           String           @db.VarChar(500)
  /// Routing ids only. No amounts, phones, names, payment ids.
  data           Json
  /// Dedupe entity for this type (consultationId or proposalId or appointmentId).
  referenceId    String
  readAt         DateTime?
  createdAt      DateTime         @default(now())

  user User @relation(...)

  @@unique([userId, type, referenceId])
  @@index([userId, createdAt])
}
```

`User` gains `notifications Notification[]`.

**Why `referenceId` + unique triple:**

| Type | `referenceId` |
|---|---|
| `CONSULTATION_REQUESTED` / `_ACCEPTED` / `_DECLINED` | `consultationId` |
| `PROPOSAL_CREATED` / `_ACCEPTED` / `_REJECTED` | `proposalId` |
| `APPOINTMENT_CONFIRMED` | `appointmentId` |

A second mock payment callback trying to insert `APPOINTMENT_CONFIRMED` for the same user+appointment hits the unique constraint → skip insert → skip extra FCM.

`readAt` is stored for a future inbox / badge. Flutter V1 may ignore it.

**Not in V1 schema:** `channel`, `status`, `sentAt`, `fcmMessageId`. Delivery is best-effort; logging is enough. Retry workers would need `sentAt` — out of scope.

**CURRENT — `test/e2e-cleanup.ts`** deletes `userDevice` then users. **PROPOSED:** `prisma.notification.deleteMany()` **before** `userDevice` / `user` (FK to User). Keep `assertTestDatabase()` as the first line. Do not change the gate.

Apply migrations to **both** `welapathkade` and `welapathkade_test` the same way Phase 5B did (`migrate deploy` per env). Never `migrate reset`.

---

## 12. API changes

### 12.1 Existing (keep / extend)

| Method | Change |
|---|---|
| `POST /auth/devices` | Keep upsert. Optionally return `{ id, platform, lastSeenAt }` (already returns the Prisma row today). |
| `POST /auth/otp/verify` | Keep optional token upsert. Flutter V1 should still call `POST /auth/devices` after Firebase is ready (token often unavailable at OTP time). |

### 12.2 PROPOSED new

| Method | Purpose |
|---|---|
| `DELETE /auth/devices` | JWT. Body `{ fcmToken }`. Delete **only if** `userId` matches caller (do not leak whether the token existed). Used on logout. |

### 12.3 Inbox REST — not required for FCM V1

**PROPOSED V1 — no `GET /notifications/me`.** Persistence is server-side only. Adding list/mark-read is a small follow-up once Flutter has a badge.

**DECISION NEEDED** if product wants unread list in the same PR. Default: **omit**.

### 12.4 Admin

No notification endpoints.

---

## 13. Event / trigger mapping

All FCM happens **after** the winning write. Recipients are **User.id** (astrologer via `AstrologerProfile.userId`, never `AstrologerProfile.id` in FCM targeting).

| Business event | Code location (CURRENT) | Notification(s) |
|---|---|---|
| Consultation created | `ConsultationsService.create` (`$transaction`) | `CONSULTATION_REQUESTED` → astrologer user |
| Astrologer accept | `ConsultationsService.accept` (`updateMany`) | `CONSULTATION_ACCEPTED` → `consultation.customerId` |
| Astrologer decline | `ConsultationsService.decline` | `CONSULTATION_DECLINED` → customer |
| Proposal created | `ConsultationProposalsService.createForAstrologer` (`withAstrologerLock`) | `PROPOSAL_CREATED` → customer |
| Proposal accepted | `ConsultationProposalsService.acceptForCustomer` | `PROPOSAL_ACCEPTED` → astrologer user |
| Proposal rejected | `ConsultationProposalsService.rejectForCustomer` | `PROPOSAL_REJECTED` → astrologer user |
| Appointment confirmed | `PaymentsService.finalizeVerified` (`withAstrologerLock`) | `APPOINTMENT_CONFIRMED` → customer **and** astrologer user (two rows, same `referenceId` = appointment id) |
| Reservation expired | `OccupancyService.expireDueReservations` | **None in V1** |
| Confirm & Pay creates `PAYMENT_PENDING` | `PaymentsService` checkout | **None** (actor is in checkout) |
| Duplicate payment callback already `CONFIRMED` | `finalizeVerified` early path | Unique constraint → **no second row / no second FCM** |

**PROPOSED — do not notify** on proposal supersede internals beyond the new `PROPOSAL_CREATED`.

---

## 14. Payload design

FCM **data** values must be strings. **PROPOSED canonical `data`:**

```json
{
  "type": "PROPOSAL_CREATED",
  "consultationId": "clxx...",
  "proposalId": "clyy...",
  "appointmentId": ""
}
```

Rules:

- Always include `type` and `consultationId` (every V1 event has a consultation).
- Include `proposalId` when the event is proposal-scoped (created/accepted/rejected). Empty string if unused (avoid omitting keys so Flutter parsing is boring).
- Include `appointmentId` only for `APPOINTMENT_CONFIRMED`.
- **Never** include: amount, currency, payment ids, providerPaymentId, phone, name, message, declineReason, tokens, emails.

**Notification (display) block** (Android/iOS system tray when backgrounded):

- `title` / `body` from server templates + `User.language`.
- Same strings stored on the `Notification` row.

**Android:** set a default channel id (e.g. `welapathkade_transactional`) in the payload / Flutter local-notifications setup.

**Deep link is not a URL in the payload.** Flutter maps `type` + `consultationId` + auth role → `GoRouter` path (§19). Avoid putting `/consultations/...` in FCM so paths can change without invalidating stored rows.

---

## 15. Flutter handling

**PROPOSED new feature module** (keep `features/auth` for API only):

- Add `firebase_core`, `firebase_messaging`.
- Add `flutter_local_notifications` for **foreground** display (FCM does not show a system notification while the Dart isolate is in foreground unless we create one).
- `Firebase.initializeApp()` in `main()` **before** `runApp`, after `WidgetsFlutterBinding.ensureInitialized()`.
- Register a **top-level** `FirebaseMessaging.onBackgroundMessage` handler (required by the plugin).
- After `AuthStatus.authenticated`: request permission (iOS + Android 13+), get token, `registerDevice` with `ANDROID` / `IOS` from `defaultTargetPlatform`.
- Subscribe `onTokenRefresh` → `registerDevice`.
- On `logout`: `DELETE /auth/devices` then existing session clear.
- Parse `data.type` with a Dart enum mirroring Prisma (unknown types: ignore, do not crash).
- Wire `GoRouter` via `AppRouter.rootNavigatorKey` (already exists).

**CURRENT — `AuthController.verifyOtp` does not pass `deviceId` either.** Out of scope unless needed; FCM registration is a post-login call.

Platform files (expected):

- Android: `google-services.json`, Google Services plugin, `POST_NOTIFICATIONS`, default channel (Flutter local notifications init).
- iOS: `GoogleService-Info.plist`, Push Notifications capability, `UIBackgroundModes` → `remote-notification`, APNs key/cert in Firebase console (manual ops, not a source file).

**Do not commit** Firebase **service account** JSON. Client plist/json are typically committed; still treat them as environment-specific and document that production vs debug apps need matching Firebase apps.

---

## 16. Foreground behavior

**CURRENT:** no FCM; SnackBars are for **errors**.

**PROPOSED:**

1. `FirebaseMessaging.onMessage` → show a **local notification** (same title/body as FCM) via `flutter_local_notifications`, and if the user is already on that consultation detail, trigger the existing detail `load()` so UI updates without a tap.
2. Tapping the local notification uses the same router as background taps.
3. Do **not** rely only on SnackBar: user may be on Home / another tab; a system-style banner is the expected mobile behavior.

**DECISION NEEDED** if product prefers SnackBar-only when `WidgetsBinding` is resumed (less native, no extra plugin). Default: **local notification**.

---

## 17. Background behavior

### Android

- App process alive, activity not focused: FCM **notification+data** messages are displayed by the system when a `notification` payload is present.
- Data-only messages may not display; **PROPOSED send both** notification and data from the Admin SDK.
- Background Dart handler: keep it **minimal** (no UI). Do not duplicate a second tray notification if the system already showed one.

### iOS

- Requires APNs token + `requestPermission`.
- Background fetch of data-only is unreliable; **notification payload is required**.
- Enable Push + remote background mode.

**CURRENT:** none of the above is configured.

---

## 18. Terminated-app behavior

**PROPOSED:**

1. `Firebase.initializeApp` in `main`.
2. After `runApp` / first frame + auth restore: `FirebaseMessaging.instance.getInitialMessage()`.
3. If a message exists and user is authenticated with matching role, `router.go` to the consultation detail.
4. If `getInitialMessage` fires before session restore: **queue** the payload until `AuthStatus.authenticated`, then navigate (avoid fighting `/splash` redirect in `app_redirect.dart`).

**CURRENT `launchMode=singleTop`** helps Android deliver the intent to the existing activity when the user taps a notification while the task exists.

---

## 19. Deep-link routing

**PROPOSED destinations (exact):**

| Type | Customer (`PUBLIC`) | Astrologer |
|---|---|---|
| `CONSULTATION_REQUESTED` | n/a | `/astrologer/consultations/:consultationId` |
| `CONSULTATION_ACCEPTED` | `/consultations/:consultationId` | n/a |
| `CONSULTATION_DECLINED` | `/consultations/:consultationId` | n/a |
| `PROPOSAL_CREATED` | `/consultations/:consultationId` | n/a |
| `PROPOSAL_ACCEPTED` | n/a | `/astrologer/consultations/:consultationId` |
| `PROPOSAL_REJECTED` | n/a | `/astrologer/consultations/:consultationId` |
| `APPOINTMENT_CONFIRMED` | `/consultations/:consultationId` | `/astrologer/consultations/:consultationId` |

**Do not** open `/consultations/:id/pay` (requires checkout `extra`) or `/consultations/:id/confirmed` (celebration screen after in-app pay). Detail screens already show proposal + appointment summary after Phase 5B.

If the authenticated role does not match the type (e.g. customer token somehow gets an astrologer-only type), **ignore**.

If consultation 404 / forbidden after navigation, existing detail error UI is enough.

**CURRENT — no URI deep links.** Do not add `welapathkade://` in V1 unless a later marketing requirement appears.

---

## 20. Reliability strategy

| Failure | PROPOSED behavior |
|---|---|
| FCM / network error | Log; leave business state intact; leave `Notification` row in place. **No automatic retry worker in V1.** |
| Invalid / unregistered token | Delete `UserDevice`; continue other tokens |
| User has 0 devices | Persist notification; skip send (inbox-ready later) |
| User has N devices | Send to all; one invalid does not abort others |
| User logged out, token still in DB | They may still get a push until unregister lands — hence logout DELETE |
| Token rotated | Upsert new; old token will fail later and be deleted |
| API success, FCM fail | Payment/consultation **stays** committed |
| Duplicate event | Unique `(userId, type, referenceId)` → no second row, no second send |

**PROPOSED delivery mode: synchronous best-effort after commit** (async `void` / `setImmediate` / `queueMicrotask` / Nest without awaiting in the HTTP handler). Do **not** add BullMQ solely to send FCM.

Rationale: V1 volume is one-to-few devices per event; Admin SDK latency is acceptable. Architecture.md’s “queue notification job” is the right *boundary* (after commit) without requiring Redis jobs.

**CURRENT Redis** must not be overloaded with a new queue in this phase.

---

## 21. Transaction boundaries

**PROPOSED pattern (same as architecture.md “commit then notify”, with persistence inside the commit):**

```text
BEGIN
  business updates (consultation / proposal / appointment+payment)
  INSERT Notification(s)   -- unique constraint = idempotency
COMMIT
then  (not in the transaction)
  FCM fan-out
```

If `INSERT` hits unique: treat as “already notified”; **do not** send FCM again.

**If FCM is inside the transaction:** a slow Google RPC holds MySQL locks (`withAstrologerLock` uses `SELECT FOR UPDATE` on `AstrologerBookingGuard`). **Never send FCM inside `withAstrologerLock`.**

**Accept/decline today are not wrapped in `$transaction`.** **PROPOSED:** wrap `updateMany` + `notification.create` in one `$transaction`, then FCM.

**Proposal create / payment finalize already run inside `withAstrologerLock`.** **PROPOSED:** create `Notification` rows **inside that same tx callback**, collect ids, send FCM **after** `withAstrologerLock` resolves.

**Occupancy `expireDueReservations`:** often called **inside** another tx (`loadOccupiedIntervals` → expire). Do not emit FCM from there in V1.

HTTP handlers must still return the existing consultation/appointment JSON even if FCM throws — `deliver()` swallows errors.

---

## 22. Idempotency strategy

| Duplicate source | CURRENT business behavior | PROPOSED notification behavior |
|---|---|---|
| Mock/PayHere callback twice | Second finalize sees `CONFIRMED`, returns success | Unique on `(userId, APPOINTMENT_CONFIRMED, appointmentId)` |
| Client double-tap accept | Second `updateMany` count 0 → 409 Conflict | No second notification |
| Replay of `POST /consultations` | Creates a **new** consultation id | New `CONSULTATION_REQUESTED` (correct) |
| New proposal after reject | New `proposalId` | New `PROPOSAL_CREATED` (correct) |
| Same proposal accept retried | 409 | Unique would also block if a row existed |

Do **not** dedupe only in memory. Do **not** use FCM `collapse_key` as the sole idempotency mechanism (it collapses delivery, not “exactly one inbox row”).

**CURRENT payment path already returns early on confirmed** — still insert notifications only when this request **created** the confirmed state **or** when inserting the row first-time inside the same successful lock. Unique insert is the source of truth if two callbacks race.

---

## 23. Security

| Topic | CURRENT | PROPOSED |
|---|---|---|
| Device register | JWT required | Keep. Never public. |
| Device delete | Missing | JWT + ownership of token |
| FCM payload | n/a | Routing ids only; no PII / money / OTP |
| Notification rows | n/a | Readable only by `userId` if a GET is added later |
| Firebase Admin key | n/a | Env / secret file **gitignored**. Never commit service accounts. `.gitignore` already ignores `.env` and `.env.*` except examples |
| Flutter `google-services.json` / plist | Missing | Client configs are not Admin keys; still do not put private keys in the app |
| Logs | OTP codes already forbidden (`architecture.md`) | Do not log full FCM tokens; suffix only |
| Admin SDK on device | n/a | Never |

**CURRENT `.env.example` has no FCM placeholders.** Add commented placeholders only (no real keys).

---

## 24. Backend tests

Keep `assertTestDatabase()` unchanged. E2E continues to use `welapathkade_test` only.

### Unit

- `NotificationService`: create with unique conflict → no throw, `created: false`.
- Type templates SI/EN.
- Device targeting: 0 / 1 / N tokens; invalid token deletes row.
- `FcmProvider` mock: business methods complete when provider rejects.
- `ConsultationsService.accept` creates customer notification; decline likewise.
- `finalizeVerified` creates two rows; second callback creates zero new rows.
- **Never** assert against live Google APIs.

### E2E

- Full flow: request → accept → propose → accept proposal → mock pay → `Notification` counts and types in DB.
- Inject `FCM_PROVIDER` mock on the Nest test module (same pattern as mocking is unused today for SMS — ConsoleSmsSender is real in E2E and only logs). **PROPOSED:** E2E uses `NoopFcmProvider` always so CI has zero Firebase config.
- `POST /auth/devices` upsert + reassign user.
- `DELETE /auth/devices` after logout path.
- Cleanup: `notification.deleteMany()` inside `resetE2eDatabase` after `assertTestDatabase()`.

---

## 25. Flutter tests

No Firebase emulator required for V1 unit tests:

- Parse `RemoteMessage.data` → enum + ids (pure Dart).
- Map type + role → path string; widget/router test with a fake `GoRouter`.
- `AuthController` after login calls `registerDevice` (inject a fake messaging facade).
- Logout calls unregister.
- Unknown `type` does not throw.

Foreground/background/terminated **cannot** be fully automated in `flutter_test`; those are §26.

---

## 26. Manual E2E tests

Use two physical/emulator devices or one emulator + one logged-out check. Firebase project + debug SHA-1 (Android) + APNs (iOS) required.

| Case | Android | iOS |
|---|---|---|
| Foreground: other party’s action shows local/system notification | Yes | Yes |
| Background: tray notification; tap opens detail | Yes | Yes |
| Terminated: tap opens detail after splash/auth | Yes | Yes |
| Token refresh (clear app data / reinstall) re-registers | Yes | Yes |
| Two devices same user both receive | Yes | Yes |
| Logout: old user stops receiving | Yes | Yes |
| Second mock payment callback: no duplicate “confirmed” push | Yes | n/a (API) |
| Permission denied: API still works; no crash | Yes | Yes |

Customer vs astrologer accounts for each type in §6.

---

## 27. Migration plan

1. Add Prisma enum + `Notification` + `User.notifications`.
2. `prisma migrate dev` on development URL (`welapathkade`) — **not** reset.
3. `prisma migrate deploy` on `.env.test` → `welapathkade_test`.
4. Update `test/e2e-cleanup.ts` delete order.
5. No data backfill (table empty).

Do not `DROP DATABASE`. Do not point E2E at `welapathkade`.

---

## 28. Exact implementation order

1. **Schema + migration** (`Notification`, enum, User relation) + e2e cleanup order. No Firebase yet.
2. **`FCM_PROVIDER` + Console/Noop + `NotificationService`** (create + fan-out + invalid token delete). Unit tests with mock provider.
3. **Wire business events** (consultations create/accept/decline, proposals create/accept/reject, payment confirm) — persist inside tx, deliver after. Unit + E2E with Noop provider.
4. **`DELETE /auth/devices`** + unit/E2E for upsert/delete.
5. **Optional env** for Firebase Admin; production provider behind credentials. `.env.example` placeholders.
6. **Flutter:** dependencies, Android/iOS Firebase client config, permissions, init, token register/refresh, logout unregister, payload parser, router from tap, foreground local notifications, `getInitialMessage` queue after auth.
7. **Manual device matrix** (§26). Fix copy/routing only after that.

Do not start Flutter Firebase until backend types and payload shape are merged (Flutter depends on stable `type` strings).

---

## 29. Files expected to change

### Backend (when implementation is approved)

- `prisma/schema.prisma`
- `prisma/migrations/<timestamp>_phase6_notifications/migration.sql` (new)
- `src/app.module.ts`
- `src/config/env.validation.ts` (optional Firebase fields)
- `.env.example` (placeholders)
- `src/notifications/**` (new module, service, providers, templates)
- `src/consultations/consultations.service.ts`
- `src/consultations/consultation-proposals.service.ts`
- `src/consultations/consultations.module.ts`
- `src/payments/payments.service.ts`
- `src/payments/payments.module.ts`
- `src/auth/auth.controller.ts` / `auth.service.ts` / `dto/auth.dto.ts` (DELETE devices)
- `src/users` Prisma relation only (via schema)
- `test/e2e-cleanup.ts`
- New `*.spec.ts` + E2E specs
- `package.json` — `firebase-admin` when production provider lands

**Do not change:** `OccupancyService` for FCM; `assert-test-database.ts` logic; PayHere; admin app.

### Flutter

- `pubspec.yaml`
- `lib/main.dart`
- `lib/features/auth/presentation/auth_controller.dart`
- `lib/features/auth/data/auth_repository_impl.dart` (DELETE devices)
- New notification bootstrap / routing helper under `lib/`
- `android/` Gradle + manifest + `google-services.json`
- `ios/` plist, entitlements, `GoogleService-Info.plist`
- Tests under `test/`
- l10n only if in-app strings are needed beyond server title/body (tap handling can use server body)

### Admin

- **None**

---

## 30. Risks

| Risk | Mitigation |
|---|---|
| Belief that Firebase was already in Flutter | It is **not**. Phase 6 includes full client bootstrap. |
| `expireDueReservations` nested in occupancy tx | Skip `PAYMENT_EXPIRED` V1 rather than send from occupancy |
| FCM inside `withAstrologerLock` | Persist in lock; send after |
| Duplicate confirmed pushes | Unique `(userId, type, referenceId)` |
| Shared phone after logout | `DELETE /auth/devices` |
| iOS silent without APNs | Treat APNs + permission as a launch blocker for iOS QA, not for Android-only staging |
| `google-services` plugin vs Flutter Gradle order | Follow current FlutterFire docs at implementation time |
| Optional Firebase env vs crash-on-boot | Console provider when creds missing |
| Consultation detail not refreshing in foreground | On `onMessage`, if current route id matches, call existing controllers’ `load()` |
| Redirect on `/splash` eats `getInitialMessage` | Queue until authenticated |
| Token DTO max 512 vs VARCHAR(191) | Unlikely issue; monitor first real tokens |
| Admin users calling `POST /auth/devices` | Harmless; Flutter admin is unsupported |

---

## 31. Unresolved decisions

| ID | Topic | Default if approved as a bundle |
|---|---|---|
| **D1** | Persist Notification rows (B) vs FCM-only (A) | **B** |
| **D2** | V1 type set as §6 (7 types, no `PAYMENT_EXPIRED`) | **Yes** |
| **D3** | Include `PAYMENT_EXPIRED` anyway (opportunistic after a future job or after expire finds ids **outside** occupancy) | **No for V1** |
| **D4** | `GET /notifications/me` + mark-read in the same phase | **No** |
| **D5** | Flutter inbox UI | **No** |
| **D6** | Logout unregisters current FCM token | **Yes** |
| **D7** | Foreground: local notification vs SnackBar-only | **Local notification** |
| **D8** | Notify customer on `APPOINTMENT_CONFIRMED` (they may still be on checkout) | **Yes** (callback-safe) |
| **D9** | BullMQ for FCM | **No** |
| **D10** | Crash API boot if Firebase Admin creds missing | **No** — Console/Noop |
| **D11** | Amounts in notification body | **No** |
| **D12** | `CONSULTATION_EXPIRED` (12h SLA) push | **No** (same check-on-read problem) |

---

### Phase 6 Readiness

**What already exists**

- `UserDevice` with unique `fcmToken`, `platform`, `lastSeenAt`, `userId` index.
- `POST /auth/devices` JWT upsert; optional token on `POST /auth/otp/verify`.
- Flutter `AuthRepository.registerDevice` HTTP client (**unused** by `AuthController`).
- Injection patterns: `SMS_SENDER`, `PAYMENT_GATEWAY`.
- Consultation/proposal/appointment APIs and Flutter detail routes to hang deep links on.
- E2E cleanup already deletes `userDevice`; `assertTestDatabase()` protects `welapathkade`.
- Android `launchMode=singleTop`.

**What is missing**

- Entire FCM send stack (`firebase-admin`, provider, Notification table).
- Flutter Firebase packages, init, permissions, Android/iOS Firebase config, APNs, channels.
- Token register/refresh/logout unregister from the app.
- Message handlers and router integration.
- Device delete API.
- Tests for devices and notifications.
- Any production Firebase project wiring (ops, not code).

**What Phase 6 will implement**

- Persistent transactional `Notification` rows + unique idempotency.
- `NotificationService` + `FCM_PROVIDER` (Firebase Admin in prod, Console/Noop otherwise).
- Seven event types wired to consultation/proposal/payment success paths.
- Device unregister on logout; Flutter token lifecycle.
- Foreground local notifications + background/terminated tap → consultation detail.
- Tests with mocked FCM; manual matrix on real devices.

**Decisions requiring approval**

- D1–D12 in §31, especially persistence (B), skipping `PAYMENT_EXPIRED`, no inbox API/UI, logout unregister, and no BullMQ.

**Recommended implementation sequence**

Schema → NotificationService + mock FCM → wire business events + E2E → device DELETE → Flutter Firebase + routing → manual Android/iOS QA.

**No implementation in this document’s PR scope. This file is the plan only.**

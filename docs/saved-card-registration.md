# Saved-card registration lifecycle and legacy PENDING cleanup

## What PayHere provides (verified against PayHere docs, 2026-11-14)

- `notify_url` (server-to-server, signed with `md5sig`) is the only channel that carries the pre-approval outcome and `customer_token`. Status codes: `2` success, `0` pending, `-1` cancelled, `-2` failed.
- `return_url` receives no status parameters. `cancel_url` receives none either.
- The Retrieval API (`/merchant/v1/payment/search`) returns successful payments only. It has no `customer_token` and does not document pre-approvals. It cannot activate a card.
- No API exists to cancel a pre-approval or invalidate a `customer_token`. Cancellation is manual in the PayHere merchant portal (Payments → Preapprovals).

## Lifecycle

1. `POST /me/payment-methods/preapproval` creates a `PENDING` row that holds `openCardSlot`. It records `CONSENT_GRANTED`. An older open attempt becomes `FAILED` / `SUPERSEDED`.
2. The customer completes or abandons the PayHere page.
3. The app calls `POST /me/payment-methods/:id/complete` with `outcome` set to `RETURNED`, `CANCELLED`, or `CLOSED`.
   - If the verified notify already activated the card, the call returns `ACTIVE`.
   - Unless the outcome is `CANCELLED`, the server waits up to 8 seconds for the notify.
   - If no verified success arrives, the attempt becomes `FAILED`, the slot is released, and the call returns `failedRegistration`.
4. `GET /me/payment-methods` returns `methods` (ACTIVE only) and `failedRegistration` (only when the newest attempt failed). `pendingRegistration` is deprecated and always `null`.
5. Backstop: the expiry sweep fails `PENDING` rows older than 30 minutes as `ABANDONED`.

### Delayed notifications

- A verified status `2` notify for a `FAILED` row stays `FAILED`. The token is never stored. `lateAuthorizationAt` is set once, and an error-level `payhere.preapproval.notify.late_authorization` line is logged. The response is 200, so PayHere stops retrying.
- Any other notify for a row that is not `PENDING` is logged as a duplicate and leaves the row unchanged.
- Updates match a single row by its `merchantReference` and are status-guarded. A notify for an old attempt therefore cannot affect a newer attempt or an `ACTIVE` card.

Investigate late authorizations:

```sql
SELECT id, userId, merchantReference, payherePaymentId, failureReason, lateAuthorizationAt
FROM SavedPaymentMethod
WHERE lateAuthorizationAt IS NOT NULL
ORDER BY lateAuthorizationAt DESC;
```

For each row, cancel the pre-approval with that `merchantReference` / `payherePaymentId` in the PayHere merchant portal. Welapathkade never holds a token for these rows, so they cannot be charged in the meantime.

## Deployment order

1. Apply the additive migration `20261114120000_saved_card_registration_outcome` with `prisma migrate deploy`. It only adds nullable columns and changes no rows.
2. Deploy the API. From this point:
   - existing `PENDING` rows are no longer shown to customers;
   - a customer starting a new registration supersedes their old `PENDING` row;
   - the first expiry sweep fails `PENDING` rows older than 30 minutes as `ABANDONED`.
3. Optional explicit cleanup, after review. Use it to resolve legacy rows with their own reason (`LEGACY_PENDING`) and an archive, before the sweep reaches them. It needs the step 1 columns. Run it between step 1 and step 2, or while the sweep is disabled (`EXPIRY_SWEEP_ENABLED`).

## Legacy PENDING cleanup script

`src/scripts/resolve-legacy-pending-saved-cards.ts` changes only rows that are `PENDING` and created before the cutoff you pass.

```bash
# Dry run: prints affected ids, writes nothing.
npm run saved-cards:resolve-legacy-pending -- --created-before 2026-11-15T00:00:00Z

# Apply: archives first, then resolves.
npm run saved-cards:resolve-legacy-pending -- --created-before 2026-11-15T00:00:00Z --apply \
  --archive-dir /var/backups/welapathkade/saved-cards
```

With `--apply`, the script:

1. Writes the affected rows (no token columns) and all their `SavedCardConsentEvent` rows to a new JSON file. It refuses to overwrite an existing file.
2. Marks exactly those ids `FAILED` / `LEGACY_PENDING`, sets `failedAt`, and releases `openCardSlot`. The update is status-guarded, so a row that a notify activated in the meantime is skipped and reported.
3. Deletes nothing. Consent events are kept.

Do not run it against production from a development machine. Run it on the production host after review, with that host's `DATABASE_URL`.

# PayHere diagnostic logging

Structured PayHere events are written as JSON lines to a dedicated log file
and are also printed through the Nest console logger.

## Log file

| Item | Value |
| --- | --- |
| Default path (Linux) | `/var/log/welapathkade/payhere.log` |
| Override | `PAYHERE_LOG_PATH` |
| Format | One JSON object per line (`ts`, `level`, `event`, …) |
| Filter | Only events whose `event` starts with `payhere.` |

Payment behaviour is unchanged. File write failures are ignored so OAuth,
charge, retrieval, and notify flows continue.

## Create the directory and file on the host

```bash
sudo mkdir -p /var/log/welapathkade
sudo touch /var/log/welapathkade/payhere.log
# Replace welapathkade with the OS user that runs the API process.
sudo chown -R welapathkade:welapathkade /var/log/welapathkade
sudo chmod 755 /var/log/welapathkade
sudo chmod 644 /var/log/welapathkade/payhere.log
```

Optional explicit path in the process environment:

```bash
export PAYHERE_LOG_PATH=/var/log/welapathkade/payhere.log
```

## Verify append access

As the API user:

```bash
sudo -u welapathkade bash -lc 'echo "{\"ts\":\"probe\",\"event\":\"payhere.probe\"}" >> /var/log/welapathkade/payhere.log'
tail -n 1 /var/log/welapathkade/payhere.log
```

After a sandbox charge or card registration, confirm live events:

```bash
grep '"event":"payhere\.' /var/log/welapathkade/payhere.log | tail -n 50
```

Useful filters:

```bash
grep payhere.preapproval.notify /var/log/welapathkade/payhere.log
grep payhere.charge /var/log/welapathkade/payhere.log
grep payhere.retrieval /var/log/welapathkade/payhere.log
grep payhere.payment.finalized /var/log/welapathkade/payhere.log
```

## Upstream error details (charge and retrieval)

When PayHere answers `POST /merchant/v1/payment/charge` or
`GET /merchant/v1/payment/search` with a non-2xx HTTP status, the existing
event gains two fields:

| Event | Level | Added fields |
| --- | --- | --- |
| `payhere.charge.response_received` | `warn` (was `log` for non-2xx) | `tokenSource`, `upstreamError` |
| `payhere.retrieval.request_error` | `warn` | `tokenSource`, `upstreamError` |

Successful (2xx) charge and retrieval lines are unchanged: same level, same
fields, no `upstreamError`. Charge classification, payment state,
reconciliation flags, and the generic retrieval error are also unchanged; the
body is read only so it can be summarized.

`tokenSource` is `fresh` when a new OAuth token was requested for the call and
`cache` when a cached token was reused. The token itself is never logged.

`upstreamError` is built from an explicit allowlist:

| Field | Source | Notes |
| --- | --- | --- |
| `httpStatus` | HTTP status | |
| `bodyFormat` | body | `json`, `non_json`, `empty`, or `unreadable` |
| `bodyLength` | body | Character count, or `null` when not read as text |
| `contentType` | `Content-Type` header | Sanitized, max 80 chars |
| `bodyStatus` | JSON `status` | e.g. PayHere `-1`, or `403` in a framework error body |
| `errorCode` | JSON `error` (string), `code`, `error_code`, or nested `error.code` | Identifier characters only, max 80 chars |
| `errorMessage` | first of JSON `error_description`, `msg`, `message`, `error_message`, or nested `error.message` | Sanitized, max 200 chars |
| `errorType` | JSON `type`, `error_type`, or nested `error.type` | Identifier characters only |
| `bodyKeys` | top-level JSON key names | Names only, never values. Keys that look sensitive (token, secret, auth, card, sig, hash, email, phone, address, name, billing, …) are dropped. Max 15 |
| `nonJsonSummary` | non-JSON body | HTML `<title>` if present, else tag-stripped text. Sanitized, max 160 chars |
| `authChallenge` | `WWW-Authenticate` header | `scheme`, `error`, `errorDescription`, `scope`, `realm`, each sanitized |
| `server` | `Server` header | Identifier characters only |
| `requestId` | `X-Request-Id`, `X-Correlation-Id`, or `CF-Ray` header | First present, identifier characters only |

Any field that is missing or does not fit its expected shape is `null`.

### Sanitizing

Every text value goes through `sanitizePayHereText`, which:

- removes control characters and collapses whitespace;
- replaces the OAuth access token, the customer token (charge only), the
  merchant secret, the app secret, and the Basic credential if PayHere echoes
  them back;
- redacts `Bearer …` / `Basic …` values and `token:` / `secret=` /
  `password` / `authorization` / `md5sig` / `hash` values;
- redacts UUIDs, 12–19 digit card-like numbers, email addresses, and any
  opaque run of 24+ token characters;
- truncates to the field limit and appends `…`.

The request body, request headers, and the response body are never logged.
Values from `upstreamError` are not returned to API callers.

Find them:

```bash
grep '"upstreamError"' /var/log/welapathkade/payhere.log | tail -n 20
```

## Network: PayHere calls use IPv4 only

PayHere checks the caller's source address against the API key's Allowed
Domains. `api.welapathkade.lk` has only an IPv4 (A) record, but the droplet
also has a public IPv6 address and `sandbox.payhere.lk` publishes IPv6
records. Node's default lookup picked IPv6, so every Merchant API call
(charge, retrieval) failed with HTTP 401 `"Access denied for the domain"`.
The same retrieval over IPv4 returned HTTP 200 (verified 2026-11-07).

The gateway therefore uses `createPayHereIpv4Fetch()`
(`src/payments/payhere/payhere-ipv4-fetch.ts`), which resolves IPv4
addresses only and never falls back to IPv6. Do not switch the gateway back
to global `fetch` unless the domain also gets an AAAA record that PayHere
accepts.

If `"Access denied for the domain"` reappears, check from the server:

```bash
curl -4 -s https://ifconfig.me; echo   # must be the A record of api.welapathkade.lk
getent ahosts api.welapathkade.lk
```

## logrotate

Install `/etc/logrotate.d/welapathkade-payhere`:

```
/var/log/welapathkade/payhere.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

Test:

```bash
sudo logrotate -d /etc/logrotate.d/welapathkade-payhere
```

## Sensitive fields

Do not expect (and must not add) these to diagnostic events:

- customer tokens / OAuth tokens / Authorization headers
- merchant or app secrets
- md5sig / signature hashes
- card PAN, CVV, holder name
- raw notify or charge response bodies
- billing profile fields

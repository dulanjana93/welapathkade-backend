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

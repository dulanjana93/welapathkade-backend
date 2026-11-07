/**
 * Sanitized PayHere diagnostic helpers.
 * These never accept or emit tokens, secrets, card data, or full payloads.
 */

export type PayHereRetrievalReason =
  | 'post_charge'
  | 'manual_reconciliation'
  | 'customer_sync'
  | 'refund_lookup';

export type PayHereLogSink = {
  log(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
};

/** Hostname and path only. Query strings are dropped (order ids live in fields). */
export function payHereDestination(url: string): {
  hostname: string;
  path: string;
} {
  try {
    const parsed = new URL(url);
    return { hostname: parsed.hostname, path: parsed.pathname };
  } catch {
    return { hostname: 'unknown', path: 'unknown' };
  }
}

export function payHereErrorCategory(error: unknown): string {
  if (error == null) return 'unknown';
  if (typeof error === 'object') {
    const name =
      'name' in error && typeof error.name === 'string' ? error.name : '';
    const message =
      'message' in error && typeof error.message === 'string'
        ? error.message
        : '';
    if (name === 'TimeoutError' || /timeout|aborted/i.test(message)) {
      return 'timeout';
    }
    if (name === 'PayHereRateLimitError' || /rate limit/i.test(message)) {
      return 'rate_limit';
    }
    if (name === 'PayHereChargeNotSentError') return 'charge_not_sent';
    if (name === 'PayHereNotificationError') {
      if (/signature/i.test(message)) return 'invalid_signature';
      if (/merchant/i.test(message)) return 'invalid_merchant';
      if (/status/i.test(message)) return 'invalid_status';
      if (/currency/i.test(message)) return 'invalid_currency';
      if (/malformed/i.test(message)) return 'malformed';
      return 'notification_rejected';
    }
    if (/oauth/i.test(message)) return 'oauth_failed';
    if (/retrieval/i.test(message)) return 'retrieval_failed';
    if (/fetch failed|network|ECONNREFUSED|ENOTFOUND/i.test(message)) {
      return 'network';
    }
    if (name) return name;
  }
  return 'unknown';
}

export function payHereErrorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0 && name.length < 80) {
      return name;
    }
  }
  return 'Error';
}

/** Values that must never appear in diagnostic log output. */
export const PAYHERE_LOG_FORBIDDEN_KEYS = [
  'customer_token',
  'customerToken',
  'access_token',
  'accessToken',
  'Authorization',
  'authorization',
  'merchantSecret',
  'appSecret',
  'md5sig',
  'card_no',
  'card_holder_name',
  'customer_token',
] as const;

export function payHereLogContainsForbidden(
  rendered: string,
  secrets: string[] = [],
): string | null {
  const lower = rendered.toLowerCase();
  for (const key of PAYHERE_LOG_FORBIDDEN_KEYS) {
    if (lower.includes(key.toLowerCase())) return key;
  }
  for (const secret of secrets) {
    if (secret && rendered.includes(secret)) return 'secret_value';
  }
  return null;
}

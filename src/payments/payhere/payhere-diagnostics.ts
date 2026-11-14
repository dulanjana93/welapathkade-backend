/**
 * Sanitized PayHere diagnostic helpers.
 * These never accept or emit tokens, secrets, card data, or full payloads.
 */

export type PayHereRetrievalReason =
  | 'post_charge'
  | 'manual_reconciliation'
  | 'expiry_sweep_reconciliation'
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

// ---------------------------------------------------------------------------
// Upstream error-response diagnostics
// ---------------------------------------------------------------------------

/** Maximum length of any sanitized upstream text value. */
export const PAYHERE_UPSTREAM_TEXT_MAX = 200;

export type PayHereBodyFormat = 'json' | 'non_json' | 'empty' | 'unreadable';

export type PayHereResponseBody = {
  format: PayHereBodyFormat;
  /** Parsed JSON value when `format` is `json`. */
  json?: unknown;
  /** Raw text, only for `non_json`. Never logged directly. */
  text?: string;
  /** Character length of the body when it was read as text. */
  length: number | null;
};

type ReadableResponse = {
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

/**
 * Reads an HTTP body once without throwing. Uses `text()` + JSON.parse when
 * available so non-JSON bodies can still be summarized, and falls back to
 * `json()` otherwise. JSON values are identical to what `response.json()`
 * would return.
 */
export async function readPayHereResponseBody(
  response: unknown,
): Promise<PayHereResponseBody> {
  const readable = (response ?? {}) as ReadableResponse;
  if (typeof readable.text === 'function') {
    let text: string;
    try {
      text = await readable.text();
    } catch {
      return { format: 'unreadable', length: null };
    }
    if (typeof text !== 'string') {
      return { format: 'unreadable', length: null };
    }
    if (text.trim() === '') return { format: 'empty', length: text.length };
    try {
      return { format: 'json', json: JSON.parse(text), length: text.length };
    } catch {
      return { format: 'non_json', text, length: text.length };
    }
  }
  if (typeof readable.json === 'function') {
    try {
      return { format: 'json', json: await readable.json(), length: null };
    } catch {
      return { format: 'unreadable', length: null };
    }
  }
  return { format: 'unreadable', length: null };
}

/**
 * Removes control characters, known secret values, and token / card / email
 * shaped substrings, then caps the length. Returns null for non-text input.
 */
export function sanitizePayHereText(
  value: unknown,
  secrets: ReadonlyArray<string | null | undefined> = [],
  max = PAYHERE_UPSTREAM_TEXT_MAX,
): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      text = text.split(secret).join('[redacted]');
    }
  }
  text = text
    .replace(/\b(bearer|basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(
      /\b(token|secret|password|authorization|md5sig|hash)(\s*[:=]\s*["']?)[^\s,;"']+/gi,
      '$1$2[redacted]',
    )
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '[redacted]',
    )
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[redacted-number]')
    .replace(/[A-Za-z0-9_\-+=.~]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Short identifier-like values only (error codes, request ids). */
function safeIdentifier(value: unknown, max = 80): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return null;
  return /^[A-Za-z0-9_.:\- ]+$/.test(trimmed) ? trimmed : null;
}

const SENSITIVE_KEY_PATTERN =
  /token|secret|auth|card|pan|cvv|cvc|expiry|sig|hash|password|email|phone|address|holder|billing|name/i;

const REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id', 'cf-ray'];

export type PayHereAuthChallenge = {
  scheme: string | null;
  error: string | null;
  errorDescription: string | null;
  scope: string | null;
  realm: string | null;
};

export type PayHereUpstreamError = {
  httpStatus: number | null;
  bodyFormat: PayHereBodyFormat;
  bodyLength: number | null;
  contentType: string | null;
  /** Top-level `status` field from a JSON body. */
  bodyStatus: number | string | null;
  /** e.g. `invalid_token`, `Forbidden`, or a `code` / `error_code` value. */
  errorCode: string | null;
  /** First of `error_description`, `msg`, `message`, `error_message`. */
  errorMessage: string | null;
  /** `type` / `error_type`, or a nested `error.type`. */
  errorType: string | null;
  /** Top-level JSON key names only (sensitive-looking names removed). */
  bodyKeys: string[] | null;
  /** Sanitized, truncated summary of a non-JSON body (HTML title if any). */
  nonJsonSummary: string | null;
  /** Parsed `WWW-Authenticate` challenge parameters. */
  authChallenge: PayHereAuthChallenge | null;
  server: string | null;
  requestId: string | null;
};

type HeaderBag = { get?: (name: string) => string | null };

function header(response: unknown, name: string): string | null {
  const headers = (response as { headers?: HeaderBag } | null)?.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  try {
    const value = headers.get(name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseAuthChallenge(
  raw: string | null,
  secrets: ReadonlyArray<string | null | undefined>,
): PayHereAuthChallenge | null {
  if (!raw) return null;
  const schemeMatch = /^\s*([A-Za-z]+)/.exec(raw);
  const params: Record<string, string> = {};
  const re = /([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    params[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return {
    scheme: safeIdentifier(schemeMatch?.[1] ?? null, 20),
    error: safeIdentifier(params.error ?? null),
    errorDescription: sanitizePayHereText(params.error_description, secrets),
    scope: sanitizePayHereText(params.scope, secrets, 100),
    realm: sanitizePayHereText(params.realm, secrets, 60),
  };
}

function firstString(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function nonJsonSummary(
  text: string | undefined,
  secrets: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!text) return null;
  const head = text.slice(0, 4000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const plain = (title ?? head)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return sanitizePayHereText(plain, secrets, 160);
}

/**
 * Builds an allowlisted, sanitized summary of a PayHere error response.
 * Never includes the body itself, request headers, or secret values.
 * Never throws.
 */
export function summarizePayHereErrorResponse(
  response: unknown,
  body: PayHereResponseBody,
  secrets: ReadonlyArray<string | null | undefined> = [],
): PayHereUpstreamError {
  const status = (response as { status?: unknown } | null)?.status;
  const summary: PayHereUpstreamError = {
    httpStatus: typeof status === 'number' ? status : null,
    bodyFormat: body.format,
    bodyLength: body.length,
    contentType: null,
    bodyStatus: null,
    errorCode: null,
    errorMessage: null,
    errorType: null,
    bodyKeys: null,
    nonJsonSummary: null,
    authChallenge: null,
    server: null,
    requestId: null,
  };
  try {
    summary.contentType = sanitizePayHereText(
      header(response, 'content-type'),
      secrets,
      80,
    );
    summary.server = safeIdentifier(header(response, 'server'), 60);
    for (const name of REQUEST_ID_HEADERS) {
      const id = safeIdentifier(header(response, name), 100);
      if (id) {
        summary.requestId = id;
        break;
      }
    }
    summary.authChallenge = parseAuthChallenge(
      header(response, 'www-authenticate'),
      secrets,
    );

    if (body.format === 'non_json') {
      summary.nonJsonSummary = nonJsonSummary(body.text, secrets);
      return summary;
    }
    const json = body.json;
    if (body.format !== 'json' || !json || typeof json !== 'object') {
      if (body.format === 'json' && json !== null && typeof json !== 'object') {
        summary.errorMessage = sanitizePayHereText(json, secrets);
      }
      return summary;
    }
    if (Array.isArray(json)) {
      summary.bodyKeys = [];
      return summary;
    }
    const record = json as Record<string, unknown>;
    summary.bodyKeys = Object.keys(record)
      .filter((key) => /^[A-Za-z0-9_]{1,40}$/.test(key))
      .filter((key) => !SENSITIVE_KEY_PATTERN.test(key))
      .slice(0, 15);
    const bodyStatus = record.status;
    summary.bodyStatus =
      typeof bodyStatus === 'number'
        ? bodyStatus
        : safeIdentifier(bodyStatus, 30);

    const rawError = record.error;
    const nested =
      rawError && typeof rawError === 'object' && !Array.isArray(rawError)
        ? (rawError as Record<string, unknown>)
        : null;

    summary.errorCode =
      safeIdentifier(nested ? null : record.error) ??
      safeIdentifier(record.code) ??
      safeIdentifier(record.error_code) ??
      safeIdentifier(nested?.code ?? null);
    const topMessage = firstString(record, [
      'error_description',
      'msg',
      'message',
      'error_message',
    ]);
    const nestedMessage = nested
      ? firstString(nested, ['message', 'msg', 'description'])
      : null;
    summary.errorMessage = sanitizePayHereText(
      topMessage ?? nestedMessage,
      secrets,
    );
    summary.errorType =
      safeIdentifier(record.type) ??
      safeIdentifier(record.error_type) ??
      safeIdentifier(nested?.type ?? null);
  } catch {
    // Diagnostics must never affect payment handling.
  }
  return summary;
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

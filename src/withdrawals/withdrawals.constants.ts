import { Prisma } from '@prisma/client';

export const WITHDRAWAL_CURRENCY = 'LKR';
export const MIN_WITHDRAWAL_AMOUNT = new Prisma.Decimal('1000.00');

/** Documented non-production key (32 bytes of 0x42). Rejected when NODE_ENV=production. */
export const BANK_ACCOUNT_ENCRYPTION_KEY_TEST_ONLY = Buffer.alloc(
  32,
  0x42,
).toString('base64');

export const RESERVED_WITHDRAWAL_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
] as const;

/**
 * Admin destination reveal rate limits (Redis fixed windows).
 *
 * Window semantics: fixed one-hour window that starts on the first INCR for a
 * given key. TTL is set atomically with that first increment and is NOT
 * refreshed on later hits. This is not a sliding/rolling window.
 */
export const WITHDRAWAL_REVEAL_WINDOW_SECONDS = 60 * 60;

/** Max failed password verifications per admin+IP per fixed window. */
export const WITHDRAWAL_REVEAL_PASSWORD_FAIL_MAX_PER_HOUR = 5;

/** Max password-verified reveals per admin per fixed window. */
export const WITHDRAWAL_REVEAL_SUCCESS_MAX_PER_HOUR = 5;

/** Redis key prefix: failed password attempts (adminId + normalized IP). */
export const WITHDRAWAL_REVEAL_PWD_FAIL_KEY_PREFIX =
  'admin:withdrawal-reveal:pwd-fail:';

/** Redis key prefix: successful password-verified reveal quota (adminId). */
export const WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX =
  'admin:withdrawal-reveal:success:';

export const WITHDRAWAL_DESTINATION_REVEALED_ACTION =
  'WITHDRAWAL_DESTINATION_REVEALED';

/** Generic 429 body — does not disclose which limiter fired. */
export const WITHDRAWAL_REVEAL_RATE_LIMIT_MESSAGE =
  'Too many requests. Try again later.';

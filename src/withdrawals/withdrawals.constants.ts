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

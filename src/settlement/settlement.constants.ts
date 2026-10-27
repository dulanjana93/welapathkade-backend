import { Prisma } from '@prisma/client';

/** Documented V1 basis: percentages of the gross consultation amount. */
export const FINANCIAL_BASIS = 'GROSS_CONSULTATION_AMOUNT' as const;

/** Astrologer share of gross (80%). */
export const ASTROLOGER_SHARE = new Prisma.Decimal('0.80');
export const ASTROLOGER_PERCENT = new Prisma.Decimal('80.00');

/** Each applicable referral share of gross (3%). */
export const REFERRAL_SHARE = new Prisma.Decimal('0.03');
export const REFERRAL_PERCENT = new Prisma.Decimal('3.00');
export const ZERO_PERCENT = new Prisma.Decimal('0.00');
export const ZERO_MONEY = new Prisma.Decimal('0.00');

/**
 * Settlement hold after successful consultation completion.
 * Distinct from the ~30-minute unpaid checkout reservation hold.
 */
export const SETTLEMENT_HOLD_MS = 24 * 60 * 60 * 1000;
export const SETTLEMENT_HOLD_HOURS = 24;

import { Prisma } from '@prisma/client';
import {
  ASTROLOGER_PERCENT,
  ASTROLOGER_SHARE,
  FINANCIAL_BASIS,
  REFERRAL_PERCENT,
  REFERRAL_SHARE,
  ZERO_MONEY,
  ZERO_PERCENT,
} from './settlement.constants';

export type SettlementAllocationInput = {
  grossAmount: Prisma.Decimal;
  /** Public user who referred the customer, if any. */
  customerReferrerUserId: string | null;
  /** Public user who referred the astrologer's account, if any. */
  astrologerReferrerUserId: string | null;
};

export type SettlementAllocation = {
  basis: typeof FINANCIAL_BASIS;
  grossAmount: Prisma.Decimal;
  astrologerPercent: Prisma.Decimal;
  astrologerAmount: Prisma.Decimal;
  customerReferrerUserId: string | null;
  customerReferralPercent: Prisma.Decimal;
  customerReferralAmount: Prisma.Decimal;
  astrologerReferrerUserId: string | null;
  astrologerReferralPercent: Prisma.Decimal;
  astrologerReferralAmount: Prisma.Decimal;
  platformPercent: Prisma.Decimal;
  platformAmount: Prisma.Decimal;
};

/** Round half-up to currency precision (2 decimal places). */
export function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Split gross G into astrologer / referral / platform allocations.
 * Referral slices are omitted (zero) when no recipient exists; those funds
 * remain in the platform residual. Platform is always the balancing residual
 * so allocations reconcile exactly to G.
 */
export function allocateSettlement(
  input: SettlementAllocationInput,
): SettlementAllocation {
  const gross = roundMoney(input.grossAmount);
  if (gross.lessThanOrEqualTo(0)) {
    throw new Error('Gross amount must be positive');
  }

  const astrologerAmount = roundMoney(gross.mul(ASTROLOGER_SHARE));

  const hasCustomerReferral = Boolean(input.customerReferrerUserId);
  const hasAstrologerReferral = Boolean(input.astrologerReferrerUserId);

  const customerReferralAmount = hasCustomerReferral
    ? roundMoney(gross.mul(REFERRAL_SHARE))
    : ZERO_MONEY;
  const astrologerReferralAmount = hasAstrologerReferral
    ? roundMoney(gross.mul(REFERRAL_SHARE))
    : ZERO_MONEY;

  const platformAmount = roundMoney(
    gross
      .minus(astrologerAmount)
      .minus(customerReferralAmount)
      .minus(astrologerReferralAmount),
  );

  // Residual percent for audit (may be 14.00 / 17.00 / 20.00 for Rs.1000).
  const platformPercent = roundMoney(platformAmount.div(gross).mul(100));

  return {
    basis: FINANCIAL_BASIS,
    grossAmount: gross,
    astrologerPercent: ASTROLOGER_PERCENT,
    astrologerAmount,
    customerReferrerUserId: hasCustomerReferral
      ? input.customerReferrerUserId
      : null,
    customerReferralPercent: hasCustomerReferral
      ? REFERRAL_PERCENT
      : ZERO_PERCENT,
    customerReferralAmount,
    astrologerReferrerUserId: hasAstrologerReferral
      ? input.astrologerReferrerUserId
      : null,
    astrologerReferralPercent: hasAstrologerReferral
      ? REFERRAL_PERCENT
      : ZERO_PERCENT,
    astrologerReferralAmount,
    platformPercent,
    platformAmount,
  };
}

/** True when allocated parts sum exactly to gross. */
export function allocationsReconcile(
  allocation: SettlementAllocation,
): boolean {
  const sum = allocation.astrologerAmount
    .plus(allocation.customerReferralAmount)
    .plus(allocation.astrologerReferralAmount)
    .plus(allocation.platformAmount);
  return sum.equals(allocation.grossAmount);
}

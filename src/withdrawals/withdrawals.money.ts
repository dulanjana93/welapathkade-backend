import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { roundMoney } from '../settlement/settlement-allocation';
import { ZERO_MONEY } from '../settlement/settlement.constants';
import {
  MIN_WITHDRAWAL_AMOUNT,
  WITHDRAWAL_CURRENCY,
} from './withdrawals.constants';

const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const MAX_AMOUNT = new Prisma.Decimal('9999999999.99');

export function parseWithdrawalAmount(raw: string): Prisma.Decimal {
  const value = raw.trim();
  if (!AMOUNT_PATTERN.test(value)) {
    throw new BadRequestException('WITHDRAWAL_INVALID_AMOUNT');
  }
  const amount = roundMoney(new Prisma.Decimal(value));
  if (amount.greaterThan(MAX_AMOUNT)) {
    throw new BadRequestException('WITHDRAWAL_INVALID_AMOUNT');
  }
  if (amount.lessThan(MIN_WITHDRAWAL_AMOUNT)) {
    throw new BadRequestException('WITHDRAWAL_BELOW_MINIMUM');
  }
  return amount;
}

export function assertWithdrawalCurrency(currency?: string): string {
  if (currency == null || currency.trim() === '') {
    return WITHDRAWAL_CURRENCY;
  }
  if (currency.trim().toUpperCase() !== WITHDRAWAL_CURRENCY) {
    throw new BadRequestException('WITHDRAWAL_UNSUPPORTED_CURRENCY');
  }
  return WITHDRAWAL_CURRENCY;
}

export type WithdrawableInput = {
  walletAvailable: Prisma.Decimal;
  /** ASTROLOGER_EARNING credits minus reversal debits. */
  earningNet: Prisma.Decimal;
  /** ASTROLOGER_REFERRAL credits minus reversal debits. Belongs to this astrologer. */
  astrologerReferralNet: Prisma.Decimal;
  paidWithdrawalDebits: Prisma.Decimal;
  reserved: Prisma.Decimal;
};

/**
 * eligibleRemaining = max(0, earningNet + referralNet − paid purpose debits).
 * withdrawable = max(0, min(walletAvailable, eligibleRemaining) − reservations).
 *
 * The caller supplies only the ledger nets that belong to one purpose.
 * Paid debits and reservations are already limited to that purpose.
 * Wallet available already subtracts ledger debits and every withdrawal debit,
 * so the min() cap does not subtract those paid debits a second time.
 * Reservations are request rows, not wallet debits.
 */
export function computeWithdrawableAmounts(input: WithdrawableInput): {
  eligibleRemaining: Prisma.Decimal;
  withdrawable: Prisma.Decimal;
} {
  const eligiblePosted = roundMoney(
    input.earningNet.plus(input.astrologerReferralNet),
  );
  const eligibleRemaining = roundMoney(
    Prisma.Decimal.max(
      ZERO_MONEY,
      eligiblePosted.minus(input.paidWithdrawalDebits),
    ),
  );
  const cappedByWallet = Prisma.Decimal.min(
    roundMoney(input.walletAvailable),
    eligibleRemaining,
  );
  const withdrawable = roundMoney(
    Prisma.Decimal.max(ZERO_MONEY, cappedByWallet.minus(input.reserved)),
  );
  return { eligibleRemaining, withdrawable };
}

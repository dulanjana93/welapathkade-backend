import { Prisma } from '@prisma/client';
import {
  computeWithdrawableAmounts,
  parseWithdrawalAmount,
} from './withdrawals.money';
import { BankAccountCrypto, maskAccountNumber } from './bank-account.crypto';

function d(value: string) {
  return new Prisma.Decimal(value);
}

describe('parseWithdrawalAmount', () => {
  it('accepts LKR 1000.00 and one-decimal amounts at the minimum', () => {
    expect(parseWithdrawalAmount('1000').toFixed(2)).toBe('1000.00');
    expect(parseWithdrawalAmount('1000.5').toFixed(2)).toBe('1000.50');
  });

  it('rejects 999.99 and invalid decimals', () => {
    expect(() => parseWithdrawalAmount('999.99')).toThrow(
      'WITHDRAWAL_BELOW_MINIMUM',
    );
    expect(() => parseWithdrawalAmount('1000.001')).toThrow(
      'WITHDRAWAL_INVALID_AMOUNT',
    );
    expect(() => parseWithdrawalAmount('1e3')).toThrow(
      'WITHDRAWAL_INVALID_AMOUNT',
    );
    expect(() => parseWithdrawalAmount('-1000')).toThrow(
      'WITHDRAWAL_INVALID_AMOUNT',
    );
  });
});

describe('computeWithdrawableAmounts', () => {
  it('subtracts reservations and excludes non-earning wallet funds', () => {
    const result = computeWithdrawableAmounts({
      walletAvailable: d('1500.00'),
      earningNet: d('800.00'),
      astrologerReferralNet: d('200.00'),
      paidWithdrawalDebits: d('0.00'),
      reserved: d('1000.00'),
    });
    expect(result.eligibleRemaining.toFixed(2)).toBe('1000.00');
    expect(result.withdrawable.toFixed(2)).toBe('0.00');
  });

  it('does not treat customer-referral-only wallet balance as withdrawable', () => {
    const result = computeWithdrawableAmounts({
      walletAvailable: d('30.00'),
      earningNet: d('0.00'),
      astrologerReferralNet: d('0.00'),
      paidWithdrawalDebits: d('0.00'),
      reserved: d('0.00'),
    });
    expect(result.withdrawable.toFixed(2)).toBe('0.00');
  });

  it('does not let a larger wallet spend more than the eligible net after paid debits', () => {
    const result = computeWithdrawableAmounts({
      walletAvailable: d('5000.00'),
      earningNet: d('1500.00'),
      astrologerReferralNet: d('0.00'),
      paidWithdrawalDebits: d('1000.00'),
      reserved: d('0.00'),
    });
    expect(result.eligibleRemaining.toFixed(2)).toBe('500.00');
    expect(result.withdrawable.toFixed(2)).toBe('500.00');
  });

  it('reduces eligible earnings by paid withdrawal debits', () => {
    const result = computeWithdrawableAmounts({
      walletAvailable: d('600.00'),
      earningNet: d('1600.00'),
      astrologerReferralNet: d('0.00'),
      paidWithdrawalDebits: d('1000.00'),
      reserved: d('0.00'),
    });
    expect(result.withdrawable.toFixed(2)).toBe('600.00');
  });
});

describe('BankAccountCrypto', () => {
  const crypto = new BankAccountCrypto({
    getOrThrow: () => Buffer.alloc(32, 9).toString('base64'),
  } as never);

  it('round-trips and masks without returning the full number from last4', () => {
    const encrypted = crypto.encrypt('1234567890');
    expect(encrypted.last4).toBe('7890');
    expect(encrypted.ciphertext).not.toContain('1234567890');
    expect(crypto.decrypt(encrypted)).toBe('1234567890');
    expect(maskAccountNumber(encrypted.last4)).toBe('••••7890');
    expect(maskAccountNumber(encrypted.last4)).not.toContain('123456');
  });
});

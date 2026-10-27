import { Prisma } from '@prisma/client';
import {
  allocateSettlement,
  allocationsReconcile,
  roundMoney,
} from './settlement-allocation';

describe('settlement allocation', () => {
  it('splits Rs.1000 with both referrals', () => {
    const a = allocateSettlement({
      grossAmount: new Prisma.Decimal('1000.00'),
      customerReferrerUserId: 'cust-ref',
      astrologerReferrerUserId: 'astro-ref',
    });
    expect(a.astrologerAmount.toFixed(2)).toBe('800.00');
    expect(a.customerReferralAmount.toFixed(2)).toBe('30.00');
    expect(a.astrologerReferralAmount.toFixed(2)).toBe('30.00');
    expect(a.platformAmount.toFixed(2)).toBe('140.00');
    expect(a.customerReferrerUserId).toBe('cust-ref');
    expect(a.astrologerReferrerUserId).toBe('astro-ref');
    expect(allocationsReconcile(a)).toBe(true);
  });

  it('splits Rs.1000 with customer referral only', () => {
    const a = allocateSettlement({
      grossAmount: new Prisma.Decimal('1000.00'),
      customerReferrerUserId: 'cust-ref',
      astrologerReferrerUserId: null,
    });
    expect(a.astrologerAmount.toFixed(2)).toBe('800.00');
    expect(a.customerReferralAmount.toFixed(2)).toBe('30.00');
    expect(a.astrologerReferralAmount.toFixed(2)).toBe('0.00');
    expect(a.platformAmount.toFixed(2)).toBe('170.00');
    expect(a.astrologerReferrerUserId).toBeNull();
    expect(allocationsReconcile(a)).toBe(true);
  });

  it('splits Rs.1000 with astrologer referral only', () => {
    const a = allocateSettlement({
      grossAmount: new Prisma.Decimal('1000.00'),
      customerReferrerUserId: null,
      astrologerReferrerUserId: 'astro-ref',
    });
    expect(a.astrologerAmount.toFixed(2)).toBe('800.00');
    expect(a.customerReferralAmount.toFixed(2)).toBe('0.00');
    expect(a.astrologerReferralAmount.toFixed(2)).toBe('30.00');
    expect(a.platformAmount.toFixed(2)).toBe('170.00');
    expect(a.customerReferrerUserId).toBeNull();
    expect(allocationsReconcile(a)).toBe(true);
  });

  it('splits Rs.1000 with no referrals — platform keeps residual', () => {
    const a = allocateSettlement({
      grossAmount: new Prisma.Decimal('1000.00'),
      customerReferrerUserId: null,
      astrologerReferrerUserId: null,
    });
    expect(a.astrologerAmount.toFixed(2)).toBe('800.00');
    expect(a.customerReferralAmount.toFixed(2)).toBe('0.00');
    expect(a.astrologerReferralAmount.toFixed(2)).toBe('0.00');
    expect(a.platformAmount.toFixed(2)).toBe('200.00');
    expect(allocationsReconcile(a)).toBe(true);
  });

  it('reconciles exactly after cent rounding on awkward amounts', () => {
    const a = allocateSettlement({
      grossAmount: new Prisma.Decimal('999.99'),
      customerReferrerUserId: 'c',
      astrologerReferrerUserId: 'a',
    });
    expect(allocationsReconcile(a)).toBe(true);
    expect(
      a.astrologerAmount
        .plus(a.customerReferralAmount)
        .plus(a.astrologerReferralAmount)
        .plus(a.platformAmount)
        .toFixed(2),
    ).toBe('999.99');
  });

  it('roundMoney uses half-up at cent precision', () => {
    expect(roundMoney(new Prisma.Decimal('1.005')).toFixed(2)).toBe('1.01');
    expect(roundMoney(new Prisma.Decimal('1.004')).toFixed(2)).toBe('1.00');
  });
});

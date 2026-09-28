import { PaymentStatus } from '@prisma/client';
import { assertPaymentTransition, isPaymentPaid } from './payment.state';

describe('payment.state', () => {
  it('allows PENDING → PAID', () => {
    expect(assertPaymentTransition(PaymentStatus.PENDING, 'SUCCESS_VERIFIED')).toBe(
      PaymentStatus.PAID,
    );
  });

  it('allows PENDING → FAILED / EXPIRED', () => {
    expect(assertPaymentTransition(PaymentStatus.PENDING, 'GATEWAY_FAILURE')).toBe(
      PaymentStatus.FAILED,
    );
    expect(assertPaymentTransition(PaymentStatus.PENDING, 'HOLD_TIMEOUT')).toBe(
      PaymentStatus.EXPIRED,
    );
  });

  it('rejects PAID → FAILED', () => {
    expect(() =>
      assertPaymentTransition(PaymentStatus.PAID, 'GATEWAY_FAILURE'),
    ).toThrow(/Invalid payment transition/);
  });

  it('identifies PAID', () => {
    expect(isPaymentPaid(PaymentStatus.PAID)).toBe(true);
    expect(isPaymentPaid(PaymentStatus.PENDING)).toBe(false);
  });
});

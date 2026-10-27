import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  Prisma,
  RefundObligation,
} from '@prisma/client';
import { SETTLEMENT_HOLD_MS } from './settlement.constants';
import {
  evaluateSettlementEligibility,
  settlementHoldExpiresAt,
} from './settlement-eligibility';

const completedAt = new Date('2026-10-01T10:00:00.000Z');

function base(overrides: Record<string, unknown> = {}) {
  return {
    appointmentStatus: AppointmentStatus.COMPLETED,
    consultationStatus: ConsultationStatus.COMPLETED,
    completedAt,
    paymentStatus: PaymentStatus.PAID,
    paymentId: 'pay-1',
    appointmentAmount: new Prisma.Decimal('1000.00'),
    paymentAmount: new Prisma.Decimal('1000.00'),
    refundObligation: null,
    manualReviewRequired: false,
    now: new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS + 1),
    ...overrides,
  };
}

describe('settlement eligibility', () => {
  it('is eligible after the 24h hold when paid and completed', () => {
    const result = evaluateSettlementEligibility(base());
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('ELIGIBLE');
    expect(result.holdExpiresAt).toEqual(settlementHoldExpiresAt(completedAt));
  });

  it('blocks before the 24h hold expires', () => {
    const result = evaluateSettlementEligibility(
      base({
        now: new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS - 1),
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('SETTLEMENT_HOLD_ACTIVE');
    expect(result.holdRemainingMs).toBeGreaterThan(0);
  });

  it('does not confuse the 30-minute checkout reservation with settlement hold', () => {
    // 45 minutes after completion is still inside the 24h settlement hold.
    const fortyFiveMinutes = 45 * 60 * 1000;
    const result = evaluateSettlementEligibility(
      base({ now: new Date(completedAt.getTime() + fortyFiveMinutes) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('SETTLEMENT_HOLD_ACTIVE');
  });

  it('rejects unpaid / failed / missing payments', () => {
    expect(
      evaluateSettlementEligibility(
        base({ paymentStatus: PaymentStatus.PENDING }),
      ).reason,
    ).toBe('PAYMENT_NOT_PAID');
    expect(
      evaluateSettlementEligibility(
        base({ paymentStatus: PaymentStatus.FAILED }),
      ).reason,
    ).toBe('PAYMENT_NOT_PAID');
    expect(
      evaluateSettlementEligibility(
        base({ paymentId: null, paymentStatus: null, paymentAmount: null }),
      ).reason,
    ).toBe('PAYMENT_MISSING');
  });

  it('rejects incomplete / cancelled / no-show appointments', () => {
    for (const status of [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
      AppointmentStatus.NO_SHOW_CUSTOMER,
      AppointmentStatus.NO_SHOW_ASTROLOGER,
      AppointmentStatus.NO_SHOW_BOTH,
    ]) {
      expect(
        evaluateSettlementEligibility(base({ appointmentStatus: status }))
          .reason,
      ).toBe('APPOINTMENT_NOT_COMPLETED');
    }
  });

  it('rejects consultation not completed', () => {
    expect(
      evaluateSettlementEligibility(
        base({ consultationStatus: ConsultationStatus.ACCEPTED }),
      ).reason,
    ).toBe('CONSULTATION_NOT_COMPLETED');
  });

  it('blocks FULL_REFUND_DUE and manual review', () => {
    expect(
      evaluateSettlementEligibility(
        base({ refundObligation: RefundObligation.FULL_REFUND_DUE }),
      ).reason,
    ).toBe('REFUND_OBLIGATION_BLOCKS_SETTLEMENT');
    expect(
      evaluateSettlementEligibility(base({ manualReviewRequired: true }))
        .reason,
    ).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('rejects inconsistent or missing amounts', () => {
    expect(
      evaluateSettlementEligibility(
        base({ paymentAmount: new Prisma.Decimal('999.00') }),
      ).reason,
    ).toBe('AMOUNT_INCONSISTENT');
    expect(
      evaluateSettlementEligibility(
        base({ appointmentAmount: new Prisma.Decimal('0') }),
      ).reason,
    ).toBe('AMOUNT_INCONSISTENT');
  });

  it('rejects missing completion timestamp', () => {
    expect(
      evaluateSettlementEligibility(base({ completedAt: null })).reason,
    ).toBe('COMPLETION_TIMESTAMP_MISSING');
  });
});

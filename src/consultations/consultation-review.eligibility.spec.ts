import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
} from '@prisma/client';
import {
  evaluateReviewEligibility,
  normalizeReviewBody,
  publicReviewAuthorLabel,
} from './consultation-review.eligibility';

describe('review eligibility', () => {
  const ok = {
    consultationStatus: ConsultationStatus.COMPLETED,
    appointmentStatus: AppointmentStatus.COMPLETED,
    refundObligation: null,
    paymentStatus: PaymentStatus.PAID,
  };

  it('allows successfully completed paid consultations', () => {
    expect(evaluateReviewEligibility(ok)).toEqual({
      eligible: true,
      reason: 'OK',
    });
  });

  it('rejects uncompleted, cancelled, no-show and refunded states', () => {
    expect(
      evaluateReviewEligibility({
        ...ok,
        consultationStatus: ConsultationStatus.ACCEPTED,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateReviewEligibility({
        ...ok,
        appointmentStatus: AppointmentStatus.CANCELLED_BY_CUSTOMER,
      }).reason,
    ).toBe('APPOINTMENT_NOT_COMPLETED');
    expect(
      evaluateReviewEligibility({
        ...ok,
        appointmentStatus: AppointmentStatus.NO_SHOW_BOTH,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateReviewEligibility({
        ...ok,
        refundObligation: 'FULL_REFUND_DUE',
      }).reason,
    ).toBe('REFUND_OBLIGATION');
    expect(
      evaluateReviewEligibility({
        ...ok,
        paymentStatus: PaymentStatus.PENDING,
      }).reason,
    ).toBe('PAYMENT_NOT_SETTLED');
  });

  it('normalizes body and author labels', () => {
    expect(normalizeReviewBody('  hi  ')).toBe('hi');
    expect(normalizeReviewBody('   ')).toBeNull();
    expect(publicReviewAuthorLabel('Nimal Perera')).toBe('Nimal');
    expect(publicReviewAuthorLabel('')).toBe('Customer');
  });
});

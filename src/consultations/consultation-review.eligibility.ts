import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  type RefundObligation,
} from '@prisma/client';

/**
 * Facts needed to decide whether a consultation may be reviewed / whether an
 * existing review still counts in public aggregates.
 *
 * Successful completion under the Phase 1 lifecycle is required. Cancelled,
 * no-show, unpaid and refund-obligation outcomes are never eligible.
 */
export type ReviewEligibilityInput = {
  consultationStatus: ConsultationStatus;
  appointmentStatus: AppointmentStatus | string | null | undefined;
  /** FULL_REFUND_DUE (or any obligation) makes the consultation ineligible. */
  refundObligation?: RefundObligation | string | null;
  /** Latest payment status when known; missing fails closed for writes. */
  paymentStatus?: PaymentStatus | string | null;
};

export type ReviewEligibilityReason =
  | 'OK'
  | 'NOT_COMPLETED'
  | 'APPOINTMENT_NOT_COMPLETED'
  | 'REFUND_OBLIGATION'
  | 'PAYMENT_NOT_SETTLED'
  | 'NO_APPOINTMENT';

export function evaluateReviewEligibility(
  input: ReviewEligibilityInput,
): { eligible: boolean; reason: ReviewEligibilityReason } {
  if (input.consultationStatus !== ConsultationStatus.COMPLETED) {
    return { eligible: false, reason: 'NOT_COMPLETED' };
  }
  if (!input.appointmentStatus) {
    return { eligible: false, reason: 'NO_APPOINTMENT' };
  }
  if (input.appointmentStatus !== AppointmentStatus.COMPLETED) {
    return { eligible: false, reason: 'APPOINTMENT_NOT_COMPLETED' };
  }
  if (input.refundObligation) {
    return { eligible: false, reason: 'REFUND_OBLIGATION' };
  }
  // Completed appointments are paid through the mock/real gateway. Anything
  // other than PAID (or a missing payment when status is still COMPLETED and
  // historically paid) fails closed for new/edited reviews.
  if (
    input.paymentStatus != null &&
    input.paymentStatus !== PaymentStatus.PAID
  ) {
    return { eligible: false, reason: 'PAYMENT_NOT_SETTLED' };
  }
  return { eligible: true, reason: 'OK' };
}

/** Public aggregates only include reviews whose consultation is still eligible. */
export function isEligibleForPublicAggregate(
  input: ReviewEligibilityInput,
): boolean {
  return evaluateReviewEligibility(input).eligible;
}

/** Privacy-safe author label: first token of the customer name, or "Customer". */
export function publicReviewAuthorLabel(fullName: string | null | undefined): string {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return 'Customer';
  const first = trimmed.split(/\s+/)[0];
  return first.length > 0 ? first : 'Customer';
}

export function normalizeReviewBody(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

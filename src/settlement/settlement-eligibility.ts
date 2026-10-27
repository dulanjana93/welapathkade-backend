import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  RefundObligation,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { SETTLEMENT_HOLD_MS } from './settlement.constants';

export type SettlementEligibilityReason =
  | 'ELIGIBLE'
  | 'APPOINTMENT_NOT_COMPLETED'
  | 'CONSULTATION_NOT_COMPLETED'
  | 'PAYMENT_NOT_PAID'
  | 'PAYMENT_MISSING'
  | 'AMOUNT_INCONSISTENT'
  | 'REFUND_OBLIGATION_BLOCKS_SETTLEMENT'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'SETTLEMENT_HOLD_ACTIVE'
  | 'COMPLETION_TIMESTAMP_MISSING';

export type SettlementEligibilityInput = {
  appointmentStatus: AppointmentStatus;
  consultationStatus: ConsultationStatus;
  /** Consultation.completedAt — authoritative hold clock. */
  completedAt: Date | null;
  paymentStatus: PaymentStatus | null;
  paymentId: string | null;
  appointmentAmount: Prisma.Decimal | string | number;
  paymentAmount: Prisma.Decimal | string | number | null;
  refundObligation: RefundObligation | null;
  manualReviewRequired: boolean;
  now: Date;
};

export type SettlementEligibilityResult = {
  eligible: boolean;
  reason: SettlementEligibilityReason;
  /** completedAt + 24h when completedAt is known. */
  holdExpiresAt: Date | null;
  /** Milliseconds remaining on the hold when still active; else 0. */
  holdRemainingMs: number;
};

export function settlementHoldExpiresAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS);
}

/**
 * Single server-side predicate for Phase A snapshot creation / future settlement.
 * Does not create funds, reverse refunds, or resolve manual review.
 */
export function evaluateSettlementEligibility(
  input: SettlementEligibilityInput,
): SettlementEligibilityResult {
  const holdExpiresAt = input.completedAt
    ? settlementHoldExpiresAt(input.completedAt)
    : null;

  if (input.appointmentStatus !== AppointmentStatus.COMPLETED) {
    return ineligible('APPOINTMENT_NOT_COMPLETED', holdExpiresAt);
  }
  if (input.consultationStatus !== ConsultationStatus.COMPLETED) {
    return ineligible('CONSULTATION_NOT_COMPLETED', holdExpiresAt);
  }
  if (!input.completedAt) {
    return ineligible('COMPLETION_TIMESTAMP_MISSING', null);
  }
  if (!input.paymentId || input.paymentStatus == null) {
    return ineligible('PAYMENT_MISSING', holdExpiresAt);
  }
  if (input.paymentStatus !== PaymentStatus.PAID) {
    return ineligible('PAYMENT_NOT_PAID', holdExpiresAt);
  }
  if (input.paymentAmount == null) {
    return ineligible('AMOUNT_INCONSISTENT', holdExpiresAt);
  }

  const appointmentAmount = new Prisma.Decimal(input.appointmentAmount);
  const paymentAmount = new Prisma.Decimal(input.paymentAmount);
  if (!appointmentAmount.equals(paymentAmount) || appointmentAmount.lte(0)) {
    return ineligible('AMOUNT_INCONSISTENT', holdExpiresAt);
  }

  if (input.refundObligation) {
    return ineligible('REFUND_OBLIGATION_BLOCKS_SETTLEMENT', holdExpiresAt);
  }
  if (input.manualReviewRequired) {
    return ineligible('MANUAL_REVIEW_REQUIRED', holdExpiresAt);
  }

  const remaining = holdExpiresAt!.getTime() - input.now.getTime();
  if (remaining > 0) {
    return {
      eligible: false,
      reason: 'SETTLEMENT_HOLD_ACTIVE',
      holdExpiresAt,
      holdRemainingMs: remaining,
    };
  }

  return {
    eligible: true,
    reason: 'ELIGIBLE',
    holdExpiresAt,
    holdRemainingMs: 0,
  };
}

function ineligible(
  reason: SettlementEligibilityReason,
  holdExpiresAt: Date | null,
): SettlementEligibilityResult {
  return {
    eligible: false,
    reason,
    holdExpiresAt,
    holdRemainingMs: 0,
  };
}

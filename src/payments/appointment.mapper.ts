import {
  Appointment,
  AppointmentStatus,
  Payment,
  PaymentAttempt,
  PaymentStatus,
} from '@prisma/client';
import { BUSINESS_TIMEZONE } from '../availability/availability.constants';
import { toMoneyString, type MoneyString } from '../common/money/money';
import { DateTime } from 'luxon';

export type PaymentAttemptView = {
  id: string;
  merchantReference: string;
  status: PaymentStatus;
  provider: string;
  createdAt: string;
};

export type PaymentView = {
  id: string;
  status: PaymentStatus;
  provider: string;
  amount: MoneyString;
  currency: string;
  paidAt: string | null;
  latestAttempt: PaymentAttemptView | null;
};

export type AppointmentView = {
  id: string;
  consultationId: string;
  proposalId: string;
  status: AppointmentStatus;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  amount: MoneyString;
  currency: string;
  reservationExpiresAt: string;
  confirmedAt: string | null;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  actualDurationSeconds: number | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  noShowRecordedAt: string | null;
  /** FULL_REFUND_DUE records an obligation; it does not mean money was refunded. */
  refundObligation: string | null;
  manualReviewRequired: boolean;
  localDate: string | null;
  localStartTime: string;
  localEndTime: string;
  timezone: string;
  payment: PaymentView | null;
};

export type CheckoutView = {
  appointment: AppointmentView;
  checkout: Record<string, unknown>;
};

type AppointmentWithPayment = Appointment & {
  payments?: Array<Payment & { attempts?: PaymentAttempt[] }>;
};

export function toAppointmentView(
  row: AppointmentWithPayment,
  checkout?: Record<string, unknown>,
): AppointmentView {
  const payment = row.payments?.[0];
  const latest = payment?.attempts
    ? [...payment.attempts].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      )[0]
    : undefined;

  const localStart = DateTime.fromJSDate(row.startAt, { zone: 'utc' }).setZone(
    BUSINESS_TIMEZONE,
  );
  const localEnd = DateTime.fromJSDate(row.endAt, { zone: 'utc' }).setZone(
    BUSINESS_TIMEZONE,
  );

  return {
    id: row.id,
    consultationId: row.consultationId,
    proposalId: row.proposalId,
    status: row.status,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    durationMinutes: row.durationMinutes,
    amount: toMoneyString(row.amount),
    currency: row.currency,
    reservationExpiresAt: row.reservationExpiresAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    sessionStartedAt: row.sessionStartedAt?.toISOString() ?? null,
    sessionEndedAt: row.sessionEndedAt?.toISOString() ?? null,
    actualDurationSeconds: row.actualDurationSeconds ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason ?? null,
    noShowRecordedAt: row.noShowRecordedAt?.toISOString() ?? null,
    refundObligation: row.refundObligation ?? null,
    manualReviewRequired: row.manualReviewRequired ?? false,
    localDate: localStart.toISODate(),
    localStartTime: localStart.toFormat('HH:mm'),
    localEndTime: localEnd.toFormat('HH:mm'),
    timezone: BUSINESS_TIMEZONE,
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          provider: payment.provider,
          amount: toMoneyString(payment.amount),
          currency: payment.currency,
          paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
          latestAttempt: latest
            ? {
                id: latest.id,
                merchantReference: latest.merchantReference,
                status: latest.status,
                provider: latest.provider,
                createdAt: latest.createdAt.toISOString(),
              }
            : null,
        }
      : null,
    ...(checkout ? {} : {}),
  };
}

/**
 * Astrologer-facing appointment view. It never carries payment details: the
 * customer's payment attempt and merchant reference are private to the
 * customer, so the payment sub-object is always null here.
 */
export function toAstrologerAppointmentView(
  row: AppointmentWithPayment,
): AppointmentView {
  return toAppointmentView({ ...row, payments: [] });
}

export function toCheckoutView(
  row: AppointmentWithPayment,
  checkout: Record<string, unknown>,
): CheckoutView {
  return {
    appointment: toAppointmentView(row),
    checkout,
  };
}

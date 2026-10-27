import type { AppointmentFinancialSnapshot } from '@prisma/client';
import { toMoneyString, type MoneyString } from '../common/money/money';

export type FinancialSnapshotView = {
  id: string;
  appointmentId: string;
  consultationId: string;
  paymentId: string;
  currency: string;
  grossAmount: MoneyString;
  basis: string;
  astrologerId: string;
  astrologerPercent: MoneyString;
  astrologerAmount: MoneyString;
  customerReferrerUserId: string | null;
  customerReferralPercent: MoneyString;
  customerReferralAmount: MoneyString;
  astrologerReferrerUserId: string | null;
  astrologerReferralPercent: MoneyString;
  astrologerReferralAmount: MoneyString;
  platformPercent: MoneyString;
  platformAmount: MoneyString;
  status: string;
  completedAt: string;
  holdExpiresAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  createdAt: string;
};

export function toFinancialSnapshotView(
  row: AppointmentFinancialSnapshot,
): FinancialSnapshotView {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    consultationId: row.consultationId,
    paymentId: row.paymentId,
    currency: row.currency,
    grossAmount: toMoneyString(row.grossAmount),
    basis: row.basis,
    astrologerId: row.astrologerId,
    astrologerPercent: toMoneyString(row.astrologerPercent),
    astrologerAmount: toMoneyString(row.astrologerAmount),
    customerReferrerUserId: row.customerReferrerUserId,
    customerReferralPercent: toMoneyString(row.customerReferralPercent),
    customerReferralAmount: toMoneyString(row.customerReferralAmount),
    astrologerReferrerUserId: row.astrologerReferrerUserId,
    astrologerReferralPercent: toMoneyString(row.astrologerReferralPercent),
    astrologerReferralAmount: toMoneyString(row.astrologerReferralAmount),
    platformPercent: toMoneyString(row.platformPercent),
    platformAmount: toMoneyString(row.platformAmount),
    status: row.status,
    completedAt: row.completedAt.toISOString(),
    holdExpiresAt: row.holdExpiresAt.toISOString(),
    postedAt: row.postedAt?.toISOString() ?? null,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

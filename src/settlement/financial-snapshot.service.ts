import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  FinancialSnapshotStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { allocateSettlement } from './settlement-allocation';
import {
  evaluateSettlementEligibility,
  type SettlementEligibilityReason,
} from './settlement-eligibility';
import {
  toFinancialSnapshotView,
  type FinancialSnapshotView,
} from './financial-snapshot.mapper';
import { FINANCIAL_BASIS, SETTLEMENT_HOLD_MS } from './settlement.constants';

export type EnsureFinancialSnapshotResult =
  | {
      ok: true;
      created: boolean;
      snapshot: FinancialSnapshotView;
    }
  | {
      ok: false;
      reason: SettlementEligibilityReason;
      holdExpiresAt: string | null;
      holdRemainingMs: number;
      existingSnapshot: FinancialSnapshotView | null;
    };

const loadInclude = {
  payments: true,
  consultation: {
    include: {
      customer: { select: { id: true, referredByUserId: true } },
    },
  },
  astrologer: {
    include: {
      user: { select: { id: true, referredByUserId: true } },
    },
  },
  financialSnapshot: true,
} satisfies Prisma.AppointmentInclude;

/**
 * Phase A financial snapshot service.
 *
 * Creates an immutable RECORDED allocation snapshot when settlement eligibility
 * passes (including the 24h hold). Phase B FinancialLedgerService posts ledger
 * credits from RECORDED → POSTED; this service never credits wallets.
 */
@Injectable()
export class FinancialSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluate eligibility and persist a snapshot when eligible.
   * Idempotent: an existing snapshot is returned without recomputation.
   */
  async ensureSnapshotForAppointment(
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<EnsureFinancialSnapshotResult> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: loadInclude,
    });
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    if (appointment.financialSnapshot) {
      return {
        ok: true,
        created: false,
        snapshot: toFinancialSnapshotView(appointment.financialSnapshot),
      };
    }

    const payment = appointment.payments[0] ?? null;
    const eligibility = evaluateSettlementEligibility({
      appointmentStatus: appointment.status,
      consultationStatus: appointment.consultation.status,
      completedAt: appointment.consultation.completedAt,
      paymentStatus: payment?.status ?? null,
      paymentId: payment?.id ?? null,
      appointmentAmount: appointment.amount,
      paymentAmount: payment?.amount ?? null,
      refundObligation: appointment.refundObligation,
      manualReviewRequired: appointment.manualReviewRequired,
      now,
    });

    if (!eligibility.eligible) {
      return {
        ok: false,
        reason: eligibility.reason,
        holdExpiresAt: eligibility.holdExpiresAt?.toISOString() ?? null,
        holdRemainingMs: eligibility.holdRemainingMs,
        existingSnapshot: null,
      };
    }

    // Eligibility already proved payment + completedAt exist.
    if (!payment || !appointment.consultation.completedAt) {
      return {
        ok: false,
        reason: 'PAYMENT_MISSING',
        holdExpiresAt: null,
        holdRemainingMs: 0,
        existingSnapshot: null,
      };
    }
    const paidPayment = payment;
    const completedAt = appointment.consultation.completedAt;
    const holdExpiresAt = eligibility.holdExpiresAt!;

    // Freeze referrer IDs from authoritative attribution at snapshot time.
    const customerReferrerUserId =
      appointment.consultation.customer.referredByUserId;
    const astrologerReferrerUserId =
      appointment.astrologer.user.referredByUserId;

    const allocation = allocateSettlement({
      grossAmount: paidPayment.amount,
      customerReferrerUserId,
      astrologerReferrerUserId,
    });

    try {
      const created = await this.prisma.appointmentFinancialSnapshot.create({
        data: {
          appointmentId: appointment.id,
          consultationId: appointment.consultationId,
          paymentId: paidPayment.id,
          currency: paidPayment.currency || appointment.currency,
          grossAmount: allocation.grossAmount,
          basis: FINANCIAL_BASIS,
          astrologerId: appointment.astrologerId,
          astrologerPercent: allocation.astrologerPercent,
          astrologerAmount: allocation.astrologerAmount,
          customerReferrerUserId: allocation.customerReferrerUserId,
          customerReferralPercent: allocation.customerReferralPercent,
          customerReferralAmount: allocation.customerReferralAmount,
          astrologerReferrerUserId: allocation.astrologerReferrerUserId,
          astrologerReferralPercent: allocation.astrologerReferralPercent,
          astrologerReferralAmount: allocation.astrologerReferralAmount,
          platformPercent: allocation.platformPercent,
          platformAmount: allocation.platformAmount,
          status: FinancialSnapshotStatus.RECORDED,
          completedAt,
          holdExpiresAt,
        },
      });
      return {
        ok: true,
        created: true,
        snapshot: toFinancialSnapshotView(created),
      };
    } catch (error) {
      // Concurrent create: return the authoritative existing row.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing =
          await this.prisma.appointmentFinancialSnapshot.findUnique({
            where: { appointmentId },
          });
        if (existing) {
          return {
            ok: true,
            created: false,
            snapshot: toFinancialSnapshotView(existing),
          };
        }
      }
      throw error;
    }
  }

  /**
   * Find COMPLETED appointments past the settlement hold that still lack a
   * snapshot, and attempt creation. Safe to overlap; each ensure is idempotent.
   */
  async createDueSnapshots(
    now: Date = new Date(),
    take = 50,
  ): Promise<{ created: number; skipped: number; errors: string[] }> {
    const result = { created: 0, skipped: 0, errors: [] as string[] };
    const holdCutoff = new Date(now.getTime() - SETTLEMENT_HOLD_MS);

    let candidates: Array<{ id: string }>;
    try {
      candidates = await this.prisma.appointment.findMany({
        where: {
          status: AppointmentStatus.COMPLETED,
          financialSnapshot: null,
          refundObligation: null,
          manualReviewRequired: false,
          consultation: {
            status: ConsultationStatus.COMPLETED,
            completedAt: { lte: holdCutoff, not: null },
          },
          payments: { some: { status: PaymentStatus.PAID } },
        },
        select: { id: true },
        take,
        orderBy: { updatedAt: 'asc' },
      });
    } catch (error) {
      result.errors.push(
        `query: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    for (const row of candidates) {
      try {
        const outcome = await this.ensureSnapshotForAppointment(row.id, now);
        if (outcome.ok && outcome.created) result.created += 1;
        else result.skipped += 1;
      } catch (error) {
        result.errors.push(
          `${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }
}

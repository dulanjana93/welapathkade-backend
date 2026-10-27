import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  PaymentStatus,
  ProposalStatus,
  type Prisma,
} from '@prisma/client';
import { SLOT_RELEASED_STATUSES } from '../payments/appointment.state';
import { PrismaService } from '../prisma/prisma.service';
import type { OccupiedInterval } from './availability.calculator';

type Db = PrismaService | Prisma.TransactionClient;

export type ExpiredReservationCounts = {
  appointments: number;
  payments: number;
  attempts: number;
};

/**
 * Occupancy for slot enumeration and Confirm & Pay / proposal accept.
 *
 * Blocking:
 *  - CONFIRMED and IN_PROGRESS appointments
 *  - PAYMENT_PENDING appointments with reservationExpiresAt > now
 *  - ACCEPTED proposals that do not already have a CONFIRMED or live hold
 *
 * Expired holds are treated as free even before the row is flipped.
 */
@Injectable()
export class OccupancyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Flips due holds (`PAYMENT_PENDING` and `reservationExpiresAt <= now`) to
   * `PAYMENT_EXPIRED`, then expires the payments/attempts of expired holds.
   * Status-guarded and idempotent. The accepted proposal is NOT touched: it
   * keeps blocking the slot and the customer may retry checkout for it.
   */
  async expireDueReservations(
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<ExpiredReservationCounts> {
    const expired = await db.appointment.updateMany({
      where: {
        status: AppointmentStatus.PAYMENT_PENDING,
        reservationExpiresAt: { lte: now },
      },
      data: { status: AppointmentStatus.PAYMENT_EXPIRED },
    });
    if (expired.count === 0) {
      return { appointments: 0, payments: 0, attempts: 0 };
    }
    const healed = await this.expireOrphanedPendingPayments(now, db);
    return { appointments: expired.count, ...healed };
  }

  /**
   * Expires `PENDING` payments (and then their `PENDING` attempts) that belong
   * to an appointment that is already `PAYMENT_EXPIRED` and past its hold.
   *
   * Idempotent, and also the recovery step for a run that flipped the
   * appointment but failed before expiring its payments: the background
   * sweeper calls it on every run, not only when a flip just happened.
   *
   * The appointment condition is part of each UPDATE itself (relation filter),
   * so a hold that is revived by a retried checkout, or a payment that was just
   * confirmed, can never be expired by a stale id list.
   */
  async expireOrphanedPendingPayments(
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<{ payments: number; attempts: number }> {
    const appointmentExpired = {
      status: AppointmentStatus.PAYMENT_EXPIRED,
      reservationExpiresAt: { lte: now },
    };
    const payments = await db.payment.updateMany({
      where: {
        status: PaymentStatus.PENDING,
        appointment: appointmentExpired,
      },
      data: { status: PaymentStatus.EXPIRED },
    });
    const attempts = await db.paymentAttempt.updateMany({
      where: {
        status: PaymentStatus.PENDING,
        payment: {
          status: PaymentStatus.EXPIRED,
          appointment: appointmentExpired,
        },
      },
      data: { status: PaymentStatus.EXPIRED },
    });
    return { payments: payments.count, attempts: attempts.count };
  }

  async loadOccupiedIntervals(params: {
    astrologerId: string;
    excludeConsultationId?: string;
    now?: Date;
    db?: Db;
  }): Promise<OccupiedInterval[]> {
    const now = params.now ?? new Date();
    const db = params.db ?? this.prisma;
    await this.expireDueReservations(now, db);

    const appointments = await db.appointment.findMany({
      where: {
        astrologerId: params.astrologerId,
        OR: [
          { status: AppointmentStatus.CONFIRMED },
          { status: AppointmentStatus.IN_PROGRESS },
          {
            status: AppointmentStatus.PAYMENT_PENDING,
            reservationExpiresAt: { gt: now },
          },
        ],
        ...(params.excludeConsultationId
          ? { consultationId: { not: params.excludeConsultationId } }
          : {}),
      },
      select: { startAt: true, endAt: true, proposalId: true },
    });

    const blockingProposalIds = new Set(appointments.map((a) => a.proposalId));

    const accepted = await db.consultationProposal.findMany({
      where: {
        status: ProposalStatus.ACCEPTED,
        consultation: { astrologerId: params.astrologerId },
        // A cancelled / no-show / completed appointment frees its slot.
        NOT: {
          appointment: { is: { status: { in: SLOT_RELEASED_STATUSES } } },
        },
        ...(params.excludeConsultationId
          ? { consultationId: { not: params.excludeConsultationId } }
          : {}),
      },
      select: {
        id: true,
        proposedStartAt: true,
        proposedEndAt: true,
      },
    });

    const intervals: OccupiedInterval[] = appointments.map((a) => ({
      startAt: a.startAt,
      endAt: a.endAt,
    }));

    for (const p of accepted) {
      if (blockingProposalIds.has(p.id)) continue;
      intervals.push({
        startAt: p.proposedStartAt,
        endAt: p.proposedEndAt,
      });
    }

    return intervals;
  }
}

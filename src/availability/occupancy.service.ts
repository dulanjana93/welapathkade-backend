import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  PaymentStatus,
  ProposalStatus,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { OccupiedInterval } from './availability.calculator';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Occupancy for slot enumeration and Confirm & Pay / proposal accept.
 *
 * Blocking:
 *  - CONFIRMED appointments
 *  - PAYMENT_PENDING appointments with reservationExpiresAt > now
 *  - ACCEPTED proposals that do not already have a CONFIRMED or live hold
 *
 * Expired holds are treated as free even before the row is flipped.
 */
@Injectable()
export class OccupancyService {
  constructor(private readonly prisma: PrismaService) {}

  async expireDueReservations(
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<void> {
    const expired = await db.appointment.updateMany({
      where: {
        status: AppointmentStatus.PAYMENT_PENDING,
        reservationExpiresAt: { lte: now },
      },
      data: { status: AppointmentStatus.PAYMENT_EXPIRED },
    });
    if (expired.count === 0) return;

    const expiredAppointments = await db.appointment.findMany({
      where: {
        status: AppointmentStatus.PAYMENT_EXPIRED,
        reservationExpiresAt: { lte: now },
        payments: { some: { status: PaymentStatus.PENDING } },
      },
      select: { id: true },
    });
    const ids = expiredAppointments.map((a) => a.id);
    if (ids.length === 0) return;

    await db.payment.updateMany({
      where: {
        appointmentId: { in: ids },
        status: PaymentStatus.PENDING,
      },
      data: { status: PaymentStatus.EXPIRED },
    });
    const payments = await db.payment.findMany({
      where: { appointmentId: { in: ids }, status: PaymentStatus.EXPIRED },
      select: { id: true },
    });
    await db.paymentAttempt.updateMany({
      where: {
        paymentId: { in: payments.map((p) => p.id) },
        status: PaymentStatus.PENDING,
      },
      data: { status: PaymentStatus.EXPIRED },
    });
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

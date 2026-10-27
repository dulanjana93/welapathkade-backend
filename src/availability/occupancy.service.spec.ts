import {
  AppointmentStatus,
  PaymentStatus,
  ProposalStatus,
} from '@prisma/client';
import { OccupancyService } from './occupancy.service';

describe('OccupancyService', () => {
  const prisma = {
    appointment: {
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    payment: {
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    paymentAttempt: { updateMany: jest.fn() },
    consultationProposal: { findMany: jest.fn() },
  };

  const service = new OccupancyService(prisma as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.appointment.updateMany.mockResolvedValue({ count: 0 });
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 0 });
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.consultationProposal.findMany.mockResolvedValue([]);
  });

  describe('expireDueReservations', () => {
    const now = new Date('2026-10-12T04:00:00.000Z');

    it('flips only PAYMENT_PENDING holds with reservationExpiresAt <= now (inclusive)', async () => {
      await service.expireDueReservations(now);
      expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
        where: {
          status: AppointmentStatus.PAYMENT_PENDING,
          reservationExpiresAt: { lte: now },
        },
        data: { status: AppointmentStatus.PAYMENT_EXPIRED },
      });
    });

    it('does nothing more and reports zeros when no hold is due', async () => {
      const counts = await service.expireDueReservations(now);
      expect(counts).toEqual({ appointments: 0, payments: 0, attempts: 0 });
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentAttempt.updateMany).not.toHaveBeenCalled();
    });

    it('expires the payments and attempts of the expired holds and reports counts', async () => {
      prisma.appointment.updateMany.mockResolvedValue({ count: 2 });
      prisma.payment.updateMany.mockResolvedValue({ count: 2 });
      prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 3 });
      const counts = await service.expireDueReservations(now);
      expect(counts).toEqual({ appointments: 2, payments: 2, attempts: 3 });
    });

    it('never touches proposals (the accepted proposal keeps blocking the slot)', async () => {
      prisma.appointment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
      await service.expireDueReservations(now);
      expect(prisma.consultationProposal.findMany).not.toHaveBeenCalled();
    });
  });

  describe('expireOrphanedPendingPayments (recovery)', () => {
    const now = new Date('2026-10-12T04:00:00.000Z');
    const expiredHold = {
      status: AppointmentStatus.PAYMENT_EXPIRED,
      reservationExpiresAt: { lte: now },
    };

    it('conditions the UPDATEs on the appointment itself, not on a stale id list', async () => {
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 2 });

      const counts = await service.expireOrphanedPendingPayments(now);

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { status: PaymentStatus.PENDING, appointment: expiredHold },
        data: { status: PaymentStatus.EXPIRED },
      });
      expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith({
        where: {
          status: PaymentStatus.PENDING,
          payment: { status: PaymentStatus.EXPIRED, appointment: expiredHold },
        },
        data: { status: PaymentStatus.EXPIRED },
      });
      expect(counts).toEqual({ payments: 1, attempts: 2 });
      // Recovery never flips appointments itself and never reads id lists.
      expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    });

    it('runs even when no appointment was flipped in this pass', async () => {
      await service.expireOrphanedPendingPayments(now);
      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  it('includes CONFIRMED and live PAYMENT_PENDING appointments', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      {
        startAt: new Date('2026-10-01T04:30:00.000Z'),
        endAt: new Date('2026-10-01T05:00:00.000Z'),
        proposalId: 'p-conf',
      },
    ]);
    prisma.consultationProposal.findMany.mockResolvedValue([]);

    const intervals = await service.loadOccupiedIntervals({
      astrologerId: 'ap-1',
    });
    expect(intervals).toHaveLength(1);
    expect(prisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          astrologerId: 'ap-1',
          OR: expect.arrayContaining([
            { status: AppointmentStatus.CONFIRMED },
            expect.objectContaining({
              status: AppointmentStatus.PAYMENT_PENDING,
            }),
          ]),
        }),
      }),
    );
  });

  it('treats IN_PROGRESS appointments as blocking', async () => {
    await service.loadOccupiedIntervals({ astrologerId: 'ap-1' });
    expect(prisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { status: AppointmentStatus.IN_PROGRESS },
          ]),
        }),
      }),
    );
  });

  it('frees the slot of cancelled / no-show / completed appointments (accepted proposal filter)', async () => {
    await service.loadOccupiedIntervals({ astrologerId: 'ap-1' });
    const where = prisma.consultationProposal.findMany.mock.calls[0][0].where;
    const released = where.NOT.appointment.is.status.in;
    expect(released).toEqual(
      expect.arrayContaining([
        AppointmentStatus.CANCELLED_BY_CUSTOMER,
        AppointmentStatus.CANCELLED_BY_ASTROLOGER,
        AppointmentStatus.NO_SHOW_CUSTOMER,
        AppointmentStatus.NO_SHOW_ASTROLOGER,
        AppointmentStatus.NO_SHOW_BOTH,
        AppointmentStatus.COMPLETED,
      ]),
    );
    // PAYMENT_EXPIRED keeps its pre-existing behaviour.
    expect(released).not.toContain(AppointmentStatus.PAYMENT_EXPIRED);
    expect(released).not.toContain(AppointmentStatus.CONFIRMED);
  });

  it('includes ACCEPTED proposals that have no live appointment', async () => {
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.consultationProposal.findMany.mockResolvedValue([
      {
        id: 'p-acc',
        proposedStartAt: new Date('2026-10-01T04:30:00.000Z'),
        proposedEndAt: new Date('2026-10-01T05:00:00.000Z'),
      },
    ]);

    const intervals = await service.loadOccupiedIntervals({
      astrologerId: 'ap-1',
    });
    expect(intervals).toEqual([
      {
        startAt: new Date('2026-10-01T04:30:00.000Z'),
        endAt: new Date('2026-10-01T05:00:00.000Z'),
      },
    ]);
    expect(prisma.consultationProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ProposalStatus.ACCEPTED,
        }),
      }),
    );
  });

  it('does not double-count an accepted proposal that already has a hold', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      {
        startAt: new Date('2026-10-01T04:30:00.000Z'),
        endAt: new Date('2026-10-01T05:00:00.000Z'),
        proposalId: 'p-acc',
      },
    ]);
    prisma.consultationProposal.findMany.mockResolvedValue([
      {
        id: 'p-acc',
        proposedStartAt: new Date('2026-10-01T04:30:00.000Z'),
        proposedEndAt: new Date('2026-10-01T05:00:00.000Z'),
      },
    ]);

    const intervals = await service.loadOccupiedIntervals({
      astrologerId: 'ap-1',
    });
    expect(intervals).toHaveLength(1);
  });
});

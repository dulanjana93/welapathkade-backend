import { AppointmentStatus, ProposalStatus } from '@prisma/client';
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
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.consultationProposal.findMany.mockResolvedValue([]);
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

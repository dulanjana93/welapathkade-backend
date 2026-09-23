import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsultationStatus,
  ProposalStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { toProposalView } from './proposal.mapper';

describe('ConsultationProposalsService', () => {
  const prisma = {
    astrologerProfile: { findUnique: jest.fn() },
    consultation: { findUnique: jest.fn() },
    consultationProposal: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const availability = {
    assertProposedSlotEligible: jest.fn(),
  };

  const bookingGuard = {
    withAstrologerLock: jest.fn(),
  };

  const service = new ConsultationProposalsService(
    prisma as never,
    availability as never,
    bookingGuard as never,
  );

  const astroUser = {
    id: 'astro-user-1',
    role: UserRole.ASTROLOGER,
    status: UserStatus.ACTIVE,
  } as never;

  const publicUser = {
    id: 'cust-1',
    role: UserRole.PUBLIC,
    status: UserStatus.ACTIVE,
  } as never;

  const start = new Date('2026-09-25T04:30:00.000Z');
  const end = new Date('2026-09-25T05:00:00.000Z');

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      userId: 'astro-user-1',
    });
    prisma.consultation.findUnique.mockResolvedValue({
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      status: ConsultationStatus.ACCEPTED,
    });
    prisma.consultationProposal.findMany.mockResolvedValue([]);
    availability.assertProposedSlotEligible.mockResolvedValue(undefined);
  });

  function mockCreatedProposal(overrides: Record<string, unknown> = {}) {
    return {
      id: 'p-1',
      consultationId: 'c-1',
      proposedStartAt: start,
      proposedEndAt: end,
      durationMinutes: 30,
      status: ProposalStatus.PENDING,
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
      respondedAt: null,
      ...overrides,
    };
  }

  it('1. creates a valid proposal', async () => {
    bookingGuard.withAstrologerLock.mockImplementation(
      async (_id: string, work: (tx: unknown) => unknown) => {
        const tx = {
          consultationProposal: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(mockCreatedProposal()),
          },
          consultation: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'c-1',
              astrologerId: 'ap-1',
              status: ConsultationStatus.ACCEPTED,
            }),
          },
        };
        return work(tx);
      },
    );

    const result = await service.createForAstrologer(astroUser, 'c-1', {
      proposedStartAt: start.toISOString(),
      durationMinutes: 30,
    });

    expect(availability.assertProposedSlotEligible).toHaveBeenCalledWith(
      expect.objectContaining({
        astrologerId: 'ap-1',
        durationMinutes: 30,
      }),
    );
    expect(result.status).toBe(ProposalStatus.PENDING);
    expect(result.proposedStartAt).toBe(start.toISOString());
    expect(result.proposedEndAt).toBe(end.toISOString());
    expect(result.durationMinutes).toBe(30);
  });

  it('2. rejects when availability validation fails before create', async () => {
    availability.assertProposedSlotEligible.mockRejectedValue(
      new BadRequestException('outside availability'),
    );

    await expect(
      service.createForAstrologer(astroUser, 'c-1', {
        proposedStartAt: start.toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(bookingGuard.withAstrologerLock).not.toHaveBeenCalled();
  });

  it('3–8. surfaces lead/horizon/weekly/boundary/exception/duration failures from availability', async () => {
    for (const message of [
      'Proposed time is outside the astrologer availability or booking horizon',
      'durationMinutes must be an integer between 15 and 240',
    ]) {
      availability.assertProposedSlotEligible.mockRejectedValueOnce(
        new BadRequestException(message),
      );
      await expect(
        service.createForAstrologer(astroUser, 'c-1', {
          proposedStartAt: start.toISOString(),
          durationMinutes: 30,
        }),
      ).rejects.toThrow(message);
    }
  });

  it('9. only assigned astrologer can create', async () => {
    prisma.consultation.findUnique.mockResolvedValue({
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'other-ap',
      status: ConsultationStatus.ACCEPTED,
    });
    await expect(
      service.createForAstrologer(astroUser, 'c-1', {
        proposedStartAt: start.toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      service.createForAstrologer(publicUser, 'c-1', {
        proposedStartAt: start.toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('10. only consultation customer can respond', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal(),
    );
    await expect(
      service.acceptForCustomer(astroUser, 'c-1', 'p-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.consultation.findUnique.mockResolvedValue({
      id: 'c-1',
      customerId: 'other-cust',
      astrologerId: 'ap-1',
      status: ConsultationStatus.ACCEPTED,
    });
    await expect(
      service.acceptForCustomer(publicUser, 'c-1', 'p-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('11. duplicate pending proposal rejected', async () => {
    bookingGuard.withAstrologerLock.mockImplementation(
      async (_id: string, work: (tx: unknown) => unknown) => {
        const tx = {
          consultationProposal: {
            findFirst: jest
              .fn()
              .mockResolvedValueOnce(mockCreatedProposal())
              .mockResolvedValue(null),
            create: jest.fn(),
          },
          consultation: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'c-1',
              astrologerId: 'ap-1',
              status: ConsultationStatus.ACCEPTED,
            }),
          },
        };
        return work(tx);
      },
    );

    await expect(
      service.createForAstrologer(astroUser, 'c-1', {
        proposedStartAt: start.toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('12. customer accepts pending proposal', async () => {
    prisma.consultationProposal.findFirst
      .mockResolvedValueOnce(mockCreatedProposal())
      .mockResolvedValueOnce(null);
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        consultationProposal: {
          findFirst: jest.fn().mockResolvedValue(null),
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(
            mockCreatedProposal({
              status: ProposalStatus.ACCEPTED,
              respondedAt: new Date('2026-09-21T11:00:00.000Z'),
            }),
          ),
        },
      };
      return fn(tx);
    });

    const result = await service.acceptForCustomer(publicUser, 'c-1', 'p-1');
    expect(result.status).toBe(ProposalStatus.ACCEPTED);
    expect(result.respondedAt).toBeTruthy();
  });

  it('13. customer rejects pending proposal', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal(),
    );
    prisma.consultationProposal.updateMany.mockResolvedValue({ count: 1 });
    prisma.consultationProposal.findUniqueOrThrow.mockResolvedValue(
      mockCreatedProposal({
        status: ProposalStatus.REJECTED,
        respondedAt: new Date('2026-09-21T11:00:00.000Z'),
      }),
    );

    const result = await service.rejectForCustomer(publicUser, 'c-1', 'p-1');
    expect(result.status).toBe(ProposalStatus.REJECTED);
  });

  it('14. cannot accept rejected proposal', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal({ status: ProposalStatus.REJECTED }),
    );
    await expect(
      service.acceptForCustomer(publicUser, 'c-1', 'p-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('15. cannot reject accepted proposal', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal({ status: ProposalStatus.ACCEPTED }),
    );
    await expect(
      service.rejectForCustomer(publicUser, 'c-1', 'p-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('16. accepted proposal supersedes competing pending proposals', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal(),
    );
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        consultationProposal: {
          findFirst: jest.fn().mockResolvedValue(null),
          updateMany,
          findUniqueOrThrow: jest.fn().mockResolvedValue(
            mockCreatedProposal({ status: ProposalStatus.ACCEPTED }),
          ),
        },
      };
      return fn(tx);
    });

    await service.acceptForCustomer(publicUser, 'c-1', 'p-1');
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: ProposalStatus.PENDING,
          id: { not: 'p-1' },
        }),
        data: expect.objectContaining({
          status: ProposalStatus.SUPERSEDED,
        }),
      }),
    );
  });

  it('17. proposal history retained (list returns all statuses)', async () => {
    prisma.consultationProposal.findMany.mockResolvedValue([
      mockCreatedProposal({ id: 'p-2', status: ProposalStatus.PENDING }),
      mockCreatedProposal({ id: 'p-1', status: ProposalStatus.REJECTED }),
    ]);
    const list = await service.listForCustomer(publicUser, 'c-1');
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toEqual(['p-2', 'p-1']);
  });

  it('18. proposal JSON/date serialization uses ISO strings', () => {
    const view = toProposalView(mockCreatedProposal() as never);
    expect(view.proposedStartAt).toBe(start.toISOString());
    expect(view.proposedEndAt).toBe(end.toISOString());
    expect(view.createdAt).toMatch(/Z$/);
    expect(view.respondedAt).toBeNull();
    expect(view.timezone).toBe('Asia/Colombo');
    expect(typeof view.durationMinutes).toBe('number');
    expect(JSON.parse(JSON.stringify(view)).proposedStartAt).toBe(
      start.toISOString(),
    );
  });

  it('rejects create when consultation is not ACCEPTED', async () => {
    prisma.consultation.findUnique.mockResolvedValue({
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      status: ConsultationStatus.PENDING,
    });
    await expect(
      service.createForAstrologer(astroUser, 'c-1', {
        proposedStartAt: start.toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

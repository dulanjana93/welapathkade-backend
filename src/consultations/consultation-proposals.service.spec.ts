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

  const occupancy = {
    loadOccupiedIntervals: jest.fn().mockResolvedValue([]),
  };

  const notifications = {
    notifyUser: jest.fn(),
    notifyAstrologerProfile: jest.fn(),
    deliverAfterCommit: jest.fn(),
  };

  const service = new ConsultationProposalsService(
    prisma as never,
    availability as never,
    bookingGuard as never,
    occupancy as never,
    notifications as never,
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
    notifications.notifyUser.mockResolvedValue('n-user');
    notifications.notifyAstrologerProfile.mockResolvedValue('n-astro');
  });

  // Transaction bookkeeping shared by the notification tests.
  const txState: { tx: unknown; done: boolean } = {
    tx: undefined,
    done: false,
  };

  /** prisma.$transaction whose guarded updateMany affects `count` rows. */
  function mockRejectTx(count: number) {
    const tx = {
      consultationProposal: {
        updateMany: jest.fn().mockResolvedValue({ count }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(
          mockCreatedProposal({
            status: ProposalStatus.REJECTED,
            respondedAt: new Date('2026-09-21T11:00:00.000Z'),
          }),
        ),
      },
    };
    prisma.$transaction.mockImplementation(
      async (fn: (t: unknown) => unknown) => {
        txState.tx = tx;
        const result = await fn(tx);
        txState.done = true;
        return result;
      },
    );
    return tx;
  }

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
              customerId: 'cust-1',
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
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal(),
    );
    bookingGuard.withAstrologerLock.mockImplementation(
      async (_id: string, work: (tx: unknown) => unknown) => {
        const tx = {
          consultation: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'c-1',
              customerId: 'cust-1',
              astrologerId: 'ap-1',
              status: ConsultationStatus.ACCEPTED,
            }),
          },
          consultationProposal: {
            findFirst: jest
              .fn()
              .mockResolvedValueOnce(mockCreatedProposal())
              .mockResolvedValueOnce(null),
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
        return work(tx);
      },
    );

    const result = await service.acceptForCustomer(publicUser, 'c-1', 'p-1');
    expect(result.status).toBe(ProposalStatus.ACCEPTED);
    expect(result.respondedAt).toBeTruthy();
    expect(bookingGuard.withAstrologerLock).toHaveBeenCalledWith(
      'ap-1',
      expect.any(Function),
    );
  });

  it('13. customer rejects pending proposal', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue(
      mockCreatedProposal(),
    );
    mockRejectTx(1);

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
    bookingGuard.withAstrologerLock.mockImplementation(
      async (_id: string, work: (tx: unknown) => unknown) => {
        const tx = {
          consultation: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'c-1',
              customerId: 'cust-1',
              astrologerId: 'ap-1',
              status: ConsultationStatus.ACCEPTED,
            }),
          },
          consultationProposal: {
            findFirst: jest
              .fn()
              .mockResolvedValueOnce(mockCreatedProposal())
              .mockResolvedValueOnce(null),
            updateMany,
            findUniqueOrThrow: jest
              .fn()
              .mockResolvedValue(
                mockCreatedProposal({ status: ProposalStatus.ACCEPTED }),
              ),
          },
        };
        return work(tx);
      },
    );

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

  describe('notification integration', () => {
    /** Lock that records the tx and when it completed. */
    function mockCreateLock(proposalId: string) {
      const tx = {
        consultationProposal: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest
            .fn()
            .mockResolvedValue(mockCreatedProposal({ id: proposalId })),
        },
        consultation: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'c-1',
            customerId: 'cust-1',
            astrologerId: 'ap-1',
            status: ConsultationStatus.ACCEPTED,
          }),
        },
      };
      bookingGuard.withAstrologerLock.mockImplementation(
        async (_id: string, work: (t: unknown) => unknown) => {
          txState.tx = tx;
          const result = await work(tx);
          txState.done = true;
          return result;
        },
      );
      return tx;
    }

    function mockAcceptLock(updateCounts: [number, number] = [1, 0]) {
      const tx = {
        consultation: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'c-1',
            customerId: 'cust-1',
            astrologerId: 'ap-1',
            status: ConsultationStatus.ACCEPTED,
          }),
        },
        consultationProposal: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(mockCreatedProposal())
            .mockResolvedValueOnce(null),
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: updateCounts[0] })
            .mockResolvedValueOnce({ count: updateCounts[1] }),
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue(
              mockCreatedProposal({ status: ProposalStatus.ACCEPTED }),
            ),
        },
      };
      bookingGuard.withAstrologerLock.mockImplementation(
        async (_id: string, work: (t: unknown) => unknown) => {
          txState.tx = tx;
          const result = await work(tx);
          txState.done = true;
          return result;
        },
      );
      return tx;
    }

    beforeEach(() => {
      txState.tx = undefined;
      txState.done = false;
    });

    const createDto = {
      proposedStartAt: start.toISOString(),
      durationMinutes: 30,
    };

    it('PROPOSAL_CREATED: customer is the recipient, keyed by the new proposal id, recorded in the lock transaction', async () => {
      const tx = mockCreateLock('p-new');
      let doneAtDelivery: boolean | undefined;
      notifications.deliverAfterCommit.mockImplementation(() => {
        doneAtDelivery = txState.done;
      });

      await service.createForAstrologer(astroUser, 'c-1', createDto);

      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(tx, 'cust-1', {
        type: 'PROPOSAL_CREATED',
        consultationId: 'c-1',
        proposalId: 'p-new',
      });
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith(['n-user']);
      expect(doneAtDelivery).toBe(true);
    });

    it('PROPOSAL_CREATED: two proposals of one consultation each notify with their own proposal id', async () => {
      mockCreateLock('p-1');
      await service.createForAstrologer(astroUser, 'c-1', createDto);
      mockCreateLock('p-2');
      await service.createForAstrologer(astroUser, 'c-1', createDto);

      const refs = (notifications.notifyUser.mock.calls as unknown[][]).map(
        (c) => c[2] as { consultationId: string; proposalId: string },
      );
      expect(refs.map((r) => r.proposalId)).toEqual(['p-1', 'p-2']);
      expect(new Set(refs.map((r) => r.consultationId))).toEqual(
        new Set(['c-1']),
      );
    });

    it('PROPOSAL_CREATED: a rejected create (existing pending proposal) records and delivers nothing', async () => {
      const tx = mockCreateLock('p-x');
      tx.consultationProposal.findFirst.mockResolvedValueOnce(
        mockCreatedProposal({ id: 'other' }),
      );
      await expect(
        service.createForAstrologer(astroUser, 'c-1', createDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('PROPOSAL_ACCEPTED: astrologer resolved through the profile id, keyed by the proposal id, in the lock transaction', async () => {
      prisma.consultationProposal.findFirst.mockResolvedValue(
        mockCreatedProposal(),
      );
      const tx = mockAcceptLock();
      let doneAtDelivery: boolean | undefined;
      notifications.deliverAfterCommit.mockImplementation(() => {
        doneAtDelivery = txState.done;
      });

      await service.acceptForCustomer(publicUser, 'c-1', 'p-1');

      expect(notifications.notifyAstrologerProfile).toHaveBeenCalledTimes(1);
      expect(notifications.notifyAstrologerProfile).toHaveBeenCalledWith(
        tx,
        'ap-1',
        { type: 'PROPOSAL_ACCEPTED', consultationId: 'c-1', proposalId: 'p-1' },
      );
      // The customer is never notified about their own action.
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith([
        'n-astro',
      ]);
      expect(doneAtDelivery).toBe(true);
    });

    it('PROPOSAL_ACCEPTED: a lost guard records and delivers nothing', async () => {
      prisma.consultationProposal.findFirst.mockResolvedValue(
        mockCreatedProposal(),
      );
      mockAcceptLock([0, 0]);
      await expect(
        service.acceptForCustomer(publicUser, 'c-1', 'p-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notifyAstrologerProfile).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('PROPOSAL_REJECTED: astrologer notified in the same transaction as the guarded update, only when one row changed', async () => {
      prisma.consultationProposal.findFirst.mockResolvedValue(
        mockCreatedProposal(),
      );
      const tx = mockRejectTx(1);
      let doneAtDelivery: boolean | undefined;
      notifications.deliverAfterCommit.mockImplementation(() => {
        doneAtDelivery = txState.done;
      });

      await service.rejectForCustomer(publicUser, 'c-1', 'p-1');

      expect(tx.consultationProposal.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.consultationProposal.updateMany).not.toHaveBeenCalled();
      expect(notifications.notifyAstrologerProfile).toHaveBeenCalledWith(
        tx,
        'ap-1',
        { type: 'PROPOSAL_REJECTED', consultationId: 'c-1', proposalId: 'p-1' },
      );
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith([
        'n-astro',
      ]);
      expect(doneAtDelivery).toBe(true);
    });

    it('PROPOSAL_REJECTED: a lost guard (0 rows) throws, records and delivers nothing', async () => {
      prisma.consultationProposal.findFirst.mockResolvedValue(
        mockCreatedProposal(),
      );
      mockRejectTx(0);
      await expect(
        service.rejectForCustomer(publicUser, 'c-1', 'p-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notifyAstrologerProfile).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('an unexpected notification failure propagates (rolls back) and nothing is delivered', async () => {
      prisma.consultationProposal.findFirst.mockResolvedValue(
        mockCreatedProposal(),
      );
      mockRejectTx(1);
      notifications.notifyAstrologerProfile.mockRejectedValueOnce(
        new Error('deadlock'),
      );
      await expect(
        service.rejectForCustomer(publicUser, 'c-1', 'p-1'),
      ).rejects.toThrow('deadlock');
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });
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

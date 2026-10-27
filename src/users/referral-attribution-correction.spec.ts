/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest mock idioms */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import {
  REFERRAL_ATTRIBUTION_CORRECT_ACTION,
  UsersService,
} from './users.service';

describe('UsersService.adminCorrectReferralAttribution', () => {
  const tx = {
    $queryRaw: jest.fn(),
    user: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    referralAttributionCorrection: {
      create: jest.fn(),
    },
  };

  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) =>
      Promise.resolve(work(tx)),
    ),
  };

  const auditService = {
    record: jest.fn(),
  };

  const service = new UsersService(prisma as never, auditService as never);

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ acquired: 1 }]);
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.referralAttributionCorrection.create.mockResolvedValue({
      id: 'corr-1',
      createdAt: new Date('2026-10-18T10:00:00.000Z'),
    });
    auditService.record.mockResolvedValue({ id: 'audit-1' });
  });

  function mockTarget(overrides: Record<string, unknown> = {}) {
    tx.user.findUnique.mockImplementation(
      ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        if (where.id === 'target-1') {
          return Promise.resolve({
            id: 'target-1',
            role: UserRole.PUBLIC,
            referredByUserId: null,
            status: UserStatus.ACTIVE,
            ...overrides,
          });
        }
        if (where.id === 'ref-1') {
          return Promise.resolve({
            id: 'ref-1',
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            referredByUserId: select?.referredByUserId ? null : undefined,
          });
        }
        if (where.id === 'ref-2') {
          return Promise.resolve({
            id: 'ref-2',
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            referredByUserId: 'ref-1',
          });
        }
        if (where.id === 'astro-1') {
          return Promise.resolve({
            id: 'astro-1',
            role: UserRole.ASTROLOGER,
            referredByUserId: null,
            status: UserStatus.ACTIVE,
          });
        }
        if (where.id === 'admin-target') {
          return Promise.resolve({
            id: 'admin-target',
            role: UserRole.ADMIN,
            referredByUserId: null,
          });
        }
        return Promise.resolve(null);
      },
    );
  }

  it('adds a missing referrer and writes correction + audit atomically', async () => {
    mockTarget();

    const result = await service.adminCorrectReferralAttribution({
      targetUserId: 'target-1',
      referrerUserId: 'ref-1',
      reason: '  Missing registration code  ',
      actorAdminId: 'admin-1',
      ip: '127.0.0.1',
    });

    expect(result).toMatchObject({
      userId: 'target-1',
      referredByUserId: 'ref-1',
      previousReferrerUserId: null,
      correctionId: 'corr-1',
      auditLogId: 'audit-1',
      reason: 'Missing registration code',
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'target-1', referredByUserId: null },
      data: { referredByUserId: 'ref-1' },
    });
    expect(tx.referralAttributionCorrection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetUserId: 'target-1',
        previousReferrerUserId: null,
        newReferrerUserId: 'ref-1',
        adminUserId: 'admin-1',
        reason: 'Missing registration code',
      }),
    });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: REFERRAL_ATTRIBUTION_CORRECT_ACTION,
        entityId: 'target-1',
        oldData: { referredByUserId: null },
        newData: expect.objectContaining({
          referredByUserId: 'ref-1',
          reason: 'Missing registration code',
          correctionId: 'corr-1',
        }),
      }),
      tx,
    );
  });

  it('changes an incorrect referrer', async () => {
    mockTarget({ referredByUserId: 'ref-old' });
    tx.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === 'target-1') {
          return Promise.resolve({
            id: 'target-1',
            role: UserRole.PUBLIC,
            referredByUserId: 'ref-old',
          });
        }
        if (where.id === 'ref-1') {
          return Promise.resolve({
            id: 'ref-1',
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            referredByUserId: null,
          });
        }
        return Promise.resolve(null);
      },
    );

    const result = await service.adminCorrectReferralAttribution({
      targetUserId: 'target-1',
      referrerUserId: 'ref-1',
      reason: 'Wrong code entered',
      actorAdminId: 'admin-1',
    });
    expect(result.previousReferrerUserId).toBe('ref-old');
    expect(result.referredByUserId).toBe('ref-1');
  });

  it('removes an incorrect referrer with null', async () => {
    tx.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === 'target-1') {
          return Promise.resolve({
            id: 'target-1',
            role: UserRole.ASTROLOGER,
            referredByUserId: 'ref-1',
          });
        }
        return Promise.resolve(null);
      },
    );

    const result = await service.adminCorrectReferralAttribution({
      targetUserId: 'target-1',
      referrerUserId: null,
      reason: 'Clear incorrect attribution',
      actorAdminId: 'admin-1',
    });
    expect(result.referredByUserId).toBeNull();
    expect(result.previousReferrerUserId).toBe('ref-1');
  });

  it('rolls back when audit insert fails', async () => {
    mockTarget();
    auditService.record.mockRejectedValue(new Error('audit down'));

    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'ref-1',
        reason: 'fix',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('audit down');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('creates no audit when the conditional update loses a race', async () => {
    mockTarget();
    tx.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'ref-1',
        reason: 'Race',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.referralAttributionCorrection.create).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('rejects unknown targets, admin targets, self-referral, and no-ops', async () => {
    tx.user.findUnique.mockResolvedValue(null);
    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'missing',
        referrerUserId: 'ref-1',
        reason: 'x',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    mockTarget();
    tx.user.findUnique.mockResolvedValue({
      id: 'admin-target',
      role: UserRole.ADMIN,
      referredByUserId: null,
    });
    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'admin-target',
        referrerUserId: 'ref-1',
        reason: 'x',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    tx.user.findUnique.mockResolvedValue({
      id: 'target-1',
      role: UserRole.PUBLIC,
      referredByUserId: null,
    });
    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'target-1',
        reason: 'x',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('Self-referral');

    tx.user.findUnique.mockResolvedValue({
      id: 'target-1',
      role: UserRole.PUBLIC,
      referredByUserId: 'ref-1',
    });
    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'ref-1',
        reason: 'noop',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('unchanged');
  });

  it('rejects suspended, non-public, and missing referrers', async () => {
    tx.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === 'target-1') {
          return Promise.resolve({
            id: 'target-1',
            role: UserRole.PUBLIC,
            referredByUserId: null,
          });
        }
        if (where.id === 'bad-ref') {
          return Promise.resolve({
            id: 'bad-ref',
            role: UserRole.ASTROLOGER,
            status: UserStatus.ACTIVE,
            referredByUserId: null,
          });
        }
        if (where.id === 'susp-ref') {
          return Promise.resolve({
            id: 'susp-ref',
            role: UserRole.PUBLIC,
            status: UserStatus.SUSPENDED,
            referredByUserId: null,
          });
        }
        return Promise.resolve(null);
      },
    );

    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'missing-ref',
        reason: 'x',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('Invalid referrer');

    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'bad-ref',
        reason: 'x',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('Invalid referrer');

    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'susp-ref',
        reason: 'x',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('Invalid referrer');
  });

  it('rejects direct and indirect referral cycles', async () => {
    // Direct: target ← referrer where referrer already points at target.
    tx.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === 'target-1') {
          return Promise.resolve({
            id: 'target-1',
            role: UserRole.PUBLIC,
            referredByUserId: null,
          });
        }
        if (where.id === 'ref-1') {
          return Promise.resolve({
            id: 'ref-1',
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            referredByUserId: 'target-1',
          });
        }
        return Promise.resolve(null);
      },
    );
    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'ref-1',
        reason: 'cycle',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('cycle');

    // Indirect: target → set to ref-2, and ref-2 → ref-1 → target.
    tx.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === 'target-1') {
          return Promise.resolve({
            id: 'target-1',
            role: UserRole.PUBLIC,
            referredByUserId: null,
          });
        }
        if (where.id === 'ref-2') {
          return Promise.resolve({
            id: 'ref-2',
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            referredByUserId: 'ref-1',
          });
        }
        if (where.id === 'ref-1') {
          return Promise.resolve({
            id: 'ref-1',
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            referredByUserId: 'target-1',
          });
        }
        return Promise.resolve(null);
      },
    );
    await expect(
      service.adminCorrectReferralAttribution({
        targetUserId: 'target-1',
        referrerUserId: 'ref-2',
        reason: 'indirect cycle',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toThrow('cycle');
  });
});

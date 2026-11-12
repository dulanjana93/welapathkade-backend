import { BadRequestException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService admin referrals', () => {
  const prisma = {
    user: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    referralAttributionCorrection: {
      findMany: jest.fn(),
    },
  };
  const auditService = {
    record: jest.fn(),
  };

  let service: UsersService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new UsersService(prisma as never, auditService as never);
  });

  it('lists referral relationships with kind and referredBy summary', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u-customer',
        name: 'Nimal',
        phone: '+94770000001',
        role: UserRole.PUBLIC,
        status: UserStatus.ACTIVE,
        referralCode: 'CUST1',
        referredByUserId: 'u-ref',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        referredBy: {
          id: 'u-ref',
          name: 'Referrer',
          role: UserRole.PUBLIC,
          status: UserStatus.ACTIVE,
          referralCode: 'REF1',
        },
      },
      {
        id: 'u-astro',
        name: 'Astro',
        phone: '+94770000002',
        role: UserRole.ASTROLOGER,
        status: UserStatus.ACTIVE,
        referralCode: 'AST1',
        referredByUserId: 'u-ref',
        createdAt: new Date('2026-03-02T00:00:00.000Z'),
        referredBy: {
          id: 'u-ref',
          name: 'Referrer',
          role: UserRole.PUBLIC,
          status: UserStatus.ACTIVE,
          referralCode: 'REF1',
        },
      },
      {
        id: 'u-none',
        name: 'Solo',
        phone: '+94770000003',
        role: UserRole.PUBLIC,
        status: UserStatus.ACTIVE,
        referralCode: 'SOLO1',
        referredByUserId: null,
        createdAt: new Date('2026-03-03T00:00:00.000Z'),
        referredBy: null,
      },
    ]);

    const rows = await service.adminListReferralRelationships({
      attribution: 'ALL',
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: { in: [UserRole.PUBLIC, UserRole.ASTROLOGER] },
        },
      }),
    );
    expect(rows[0].referralKind).toBe('CUSTOMER');
    expect(rows[1].referralKind).toBe('ASTROLOGER');
    expect(rows[2].referralKind).toBeNull();
    expect(rows[0].referredBy).toEqual(
      expect.objectContaining({ id: 'u-ref', referralCode: 'REF1' }),
    );
  });

  it('filters attributed and role', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await service.adminListReferralRelationships({
      role: UserRole.ASTROLOGER,
      attribution: 'ATTRIBUTED',
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: UserRole.ASTROLOGER,
          referredByUserId: { not: null },
        },
      }),
    );
  });

  it('lists corrections with previous/new referrer summaries', async () => {
    prisma.referralAttributionCorrection.findMany.mockResolvedValue([
      {
        id: 'c1',
        targetUserId: 'u-target',
        previousReferrerUserId: 'u-old',
        newReferrerUserId: 'u-new',
        adminUserId: 'admin-1',
        reason: 'Wrong code at signup',
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        targetUser: {
          id: 'u-target',
          name: 'Target',
          role: UserRole.PUBLIC,
          referralCode: 'T1',
        },
        admin: { id: 'admin-1', name: 'Admin' },
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u-old',
        name: 'Old',
        role: UserRole.PUBLIC,
        referralCode: 'OLD1',
      },
      {
        id: 'u-new',
        name: 'New',
        role: UserRole.PUBLIC,
        referralCode: 'NEW1',
      },
    ]);

    const rows = await service.adminListReferralCorrections(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'c1',
      reason: 'Wrong code at signup',
      adminName: 'Admin',
      previousReferrer: { id: 'u-old', referralCode: 'OLD1' },
      newReferrer: { id: 'u-new', referralCode: 'NEW1' },
      createdAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('resolves a public referrer code for admin UI', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-ref',
      name: 'Referrer',
      role: UserRole.PUBLIC,
      status: UserStatus.ACTIVE,
      referralCode: 'REF1',
    });

    const resolved = await service.adminResolveReferrerCode(' REF1 ');
    expect(resolved).toEqual({
      id: 'u-ref',
      name: 'Referrer',
      role: UserRole.PUBLIC,
      status: UserStatus.ACTIVE,
      referralCode: 'REF1',
    });
  });

  it('rejects empty resolve-code input', async () => {
    await expect(service.adminResolveReferrerCode('   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService admin users', () => {
  const prisma = {
    user: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
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

  const baseUser = {
    id: 'u1',
    name: 'Nimal',
    phone: '+94771234567',
    email: null,
    role: UserRole.PUBLIC,
    status: UserStatus.ACTIVE,
    language: 'SI',
    referralCode: 'REF1',
    referredByUserId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    astrologerProfile: null,
  };

  it('lists users with optional role filter and never exposes passwordHash', async () => {
    prisma.user.findMany.mockResolvedValue([
      { ...baseUser, passwordHash: 'secret-hash' },
    ]);

    const rows = await service.adminList({ role: UserRole.PUBLIC });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: UserRole.PUBLIC },
      }),
    );
    expect(rows[0]).toMatchObject({
      id: 'u1',
      phone: '+94771234567',
      role: UserRole.PUBLIC,
    });
    expect(rows[0]).not.toHaveProperty('passwordHash');
  });

  it('returns user detail with referredBy and masked bank accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      referredBy: {
        id: 'ref1',
        name: 'Referrer',
        role: UserRole.PUBLIC,
        status: UserStatus.ACTIVE,
      },
      bankAccounts: [
        {
          id: 'ba1',
          bankName: 'Commercial Bank',
          accountHolderName: 'Nimal',
          branchName: 'Kandy',
          bankCode: '7056',
          branchCode: '001',
          accountNumberLast4: '9012',
          accountNumberCiphertext: 'cipher-should-not-leak',
          isActive: true,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-02T00:00:00.000Z'),
        },
      ],
    });

    const detail = await service.adminGetById('u1');
    expect(detail.referredBy).toEqual({
      id: 'ref1',
      name: 'Referrer',
      role: UserRole.PUBLIC,
      status: UserStatus.ACTIVE,
    });
    expect(detail.bankAccounts).toEqual([
      {
        id: 'ba1',
        bankName: 'Commercial Bank',
        accountHolderName: 'Nimal',
        branchName: 'Kandy',
        bankCode: '7056',
        branchCode: '001',
        accountNumberMasked: '••••9012',
        isActive: true,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-02T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(detail)).not.toContain('cipher-should-not-leak');
    expect(detail.bankAccountsNote).toMatch(/masked/i);
  });

  it('throws when user detail is missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.adminGetById('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates status and records audit', async () => {
    prisma.user.findUnique.mockResolvedValue(baseUser);
    prisma.user.update.mockResolvedValue({
      ...baseUser,
      status: UserStatus.SUSPENDED,
    });

    const updated = await service.adminUpdateStatus({
      id: 'u1',
      status: UserStatus.SUSPENDED,
      actorAdminId: 'admin-1',
      ip: '127.0.0.1',
    });

    expect(updated.status).toBe(UserStatus.SUSPENDED);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_STATUS_UPDATE',
        entityId: 'u1',
        oldData: { status: UserStatus.ACTIVE },
        newData: { status: UserStatus.SUSPENDED },
      }),
    );
  });

  it('rejects self status changes', async () => {
    await expect(
      service.adminUpdateStatus({
        id: 'admin-1',
        status: UserStatus.SUSPENDED,
        actorAdminId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

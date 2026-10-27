/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest mock idioms */
import {
  Language,
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
  UserRole,
  UserStatus,
  type User,
} from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { EarningsService } from './earnings.service';

function d(value: string) {
  return new Prisma.Decimal(value);
}

function user(partial: Partial<User> & Pick<User, 'id' | 'role'>): User {
  return {
    phone: '+94770000000',
    email: null,
    passwordHash: null,
    name: 'Test',
    status: UserStatus.ACTIVE,
    language: Language.EN,
    referralCode: 'REF1',
    referredByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe('EarningsService', () => {
  const prisma = {
    walletAccount: { findUnique: jest.fn() },
    ledgerEntry: {
      groupBy: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const service = new EarningsService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('summary', () => {
    it('returns wallet balance and category nets excluding platform residual', async () => {
      const u = user({ id: 'u1', role: UserRole.ASTROLOGER });
      prisma.walletAccount.findUnique.mockResolvedValue({
        userId: 'u1',
        availableBalance: d('770.00'),
        currency: 'LKR',
      });
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        {
          category: LedgerCategory.ASTROLOGER_EARNING,
          kind: LedgerEntryKind.CREDIT,
          _sum: { amount: d('800.00') },
          _count: { _all: 1 },
        },
        {
          category: LedgerCategory.ASTROLOGER_EARNING,
          kind: LedgerEntryKind.DEBIT,
          _sum: { amount: d('30.00') },
          _count: { _all: 1 },
        },
        {
          category: LedgerCategory.ASTROLOGER_REFERRAL,
          kind: LedgerEntryKind.CREDIT,
          _sum: { amount: d('30.00') },
          _count: { _all: 1 },
        },
      ]);

      const result = await service.summary(u);

      expect(result.availableBalance).toBe('770.00');
      expect(result.currency).toBe('LKR');
      expect(result.byCategory.ASTROLOGER_EARNING).toEqual({
        creditAmount: '800.00',
        debitAmount: '30.00',
        netAmount: '770.00',
        creditCount: 1,
        debitCount: 1,
      });
      expect(result.byCategory.ASTROLOGER_REFERRAL.netAmount).toBe('30.00');
      expect(result.byCategory.CUSTOMER_REFERRAL.netAmount).toBe('0.00');
      expect(result.notes.platformResidualNeverIncluded).toBe(true);
      expect(result.notes.availableIsInternalWalletNotPayout).toBe(true);
      expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            category: {
              in: [
                LedgerCategory.ASTROLOGER_EARNING,
                LedgerCategory.CUSTOMER_REFERRAL,
                LedgerCategory.ASTROLOGER_REFERRAL,
              ],
            },
          }),
        }),
      );
    });

    it('defaults balance to zero when wallet missing', async () => {
      prisma.walletAccount.findUnique.mockResolvedValue(null);
      prisma.ledgerEntry.groupBy.mockResolvedValue([]);
      const result = await service.summary(
        user({ id: 'u2', role: UserRole.PUBLIC }),
      );
      expect(result.availableBalance).toBe('0.00');
      expect(result.currency).toBe('LKR');
    });

    it('rejects admin role', async () => {
      await expect(
        service.summary(user({ id: 'a1', role: UserRole.ADMIN })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.walletAccount.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('listLedger', () => {
    it('scopes rows to authenticated user and signs amounts', async () => {
      const u = user({ id: 'u1', role: UserRole.PUBLIC });
      prisma.ledgerEntry.count.mockResolvedValue(2);
      prisma.ledgerEntry.findMany.mockResolvedValue([
        {
          id: 'e1',
          category: LedgerCategory.CUSTOMER_REFERRAL,
          kind: LedgerEntryKind.CREDIT,
          amount: d('30.00'),
          currency: 'LKR',
          appointmentId: 'ap1',
          consultationId: 'c1',
          paymentId: 'p1',
          snapshotId: 's1',
          reversesEntryId: null,
          createdAt: new Date('2026-10-01T12:00:00.000Z'),
        },
        {
          id: 'e2',
          category: LedgerCategory.CUSTOMER_REFERRAL,
          kind: LedgerEntryKind.DEBIT,
          amount: d('30.00'),
          currency: 'LKR',
          appointmentId: 'ap1',
          consultationId: 'c1',
          paymentId: 'p1',
          snapshotId: 's1',
          reversesEntryId: 'e1',
          createdAt: new Date('2026-10-02T12:00:00.000Z'),
        },
      ]);

      const result = await service.listLedger(u, { page: 1, pageSize: 20 });

      expect(result.total).toBe(2);
      expect(result.items[0].signedAmount).toBe('30.00');
      expect(result.items[1].signedAmount).toBe('-30.00');
      expect(result.items[1].reversesEntryId).toBe('e1');
      expect(result.items[0]).not.toHaveProperty('idempotencyKey');
      expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'u1' }),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('rejects platform residual category filter', async () => {
      await expect(
        service.listLedger(user({ id: 'u1', role: UserRole.ASTROLOGER }), {
          category: LedgerCategory.PLATFORM_RESIDUAL,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ledgerEntry.findMany).not.toHaveBeenCalled();
    });
  });
});

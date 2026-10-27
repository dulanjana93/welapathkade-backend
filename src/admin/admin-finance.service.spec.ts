/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest mock idioms */
import {
  FinancialSnapshotStatus,
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
  WithdrawalStatus,
} from '@prisma/client';
import { AdminFinanceService } from './admin-finance.service';
import { PLATFORM_ACCOUNT_ID } from '../settlement/ledger.constants';

function d(value: string) {
  return new Prisma.Decimal(value);
}

describe('AdminFinanceService', () => {
  const prisma = {
    appointmentFinancialSnapshot: {
      groupBy: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    ledgerEntry: {
      groupBy: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    appointment: {
      aggregate: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    walletAccount: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    platformAccount: {
      findUnique: jest.fn(),
    },
    withdrawalRequest: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    withdrawalDebit: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: null } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };

  const service = new AdminFinanceService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('overview', () => {
    it('returns empty aggregates and decimal strings', async () => {
      prisma.appointmentFinancialSnapshot.groupBy.mockResolvedValue([]);
      prisma.ledgerEntry.groupBy.mockResolvedValue([]);
      prisma.appointment.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { amount: null },
      });
      prisma.appointment.count.mockResolvedValue(0);

      const result = await service.overview({});
      expect(result.snapshotsByStatus.RECORDED).toEqual({
        count: 0,
        grossAmount: '0.00',
      });
      expect(result.postedGrossAmount).toBe('0.00');
      expect(result.ledgerByCategory.ASTROLOGER_EARNING.netAmount).toBe('0.00');
      expect(result.refundObligations.count).toBe(0);
      expect(result.manualReview.count).toBe(0);
      expect(result).not.toHaveProperty('reconciliationIssueCount');
    });

    it('aggregates snapshot statuses and signed ledger nets', async () => {
      prisma.appointmentFinancialSnapshot.groupBy.mockResolvedValue([
        {
          status: FinancialSnapshotStatus.POSTED,
          _count: { _all: 2 },
          _sum: { grossAmount: d('2000.00') },
        },
        {
          status: FinancialSnapshotStatus.REVERSED,
          _count: { _all: 1 },
          _sum: { grossAmount: d('1000.00') },
        },
      ]);
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        {
          category: LedgerCategory.ASTROLOGER_EARNING,
          kind: LedgerEntryKind.CREDIT,
          _count: { _all: 2 },
          _sum: { amount: d('1600.00') },
        },
        {
          category: LedgerCategory.ASTROLOGER_EARNING,
          kind: LedgerEntryKind.DEBIT,
          _count: { _all: 1 },
          _sum: { amount: d('800.00') },
        },
        {
          category: LedgerCategory.PLATFORM_RESIDUAL,
          kind: LedgerEntryKind.CREDIT,
          _count: { _all: 2 },
          _sum: { amount: d('400.00') },
        },
      ]);
      prisma.appointment.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _sum: { amount: d('3000.00') },
      });
      prisma.appointment.count.mockResolvedValue(1);

      const result = await service.overview({});
      expect(result.snapshotsByStatus.POSTED).toEqual({
        count: 2,
        grossAmount: '2000.00',
      });
      expect(result.postedGrossAmount).toBe('2000.00');
      expect(result.ledgerByCategory.ASTROLOGER_EARNING).toEqual({
        creditAmount: '1600.00',
        debitAmount: '800.00',
        netAmount: '800.00',
        creditCount: 2,
        debitCount: 1,
      });
      expect(result.refundObligations.grossAmount).toBe('3000.00');
      expect(result.manualReview.count).toBe(1);
    });

    it('keeps astrologer withdrawal totals separate from customer referral payouts', async () => {
      prisma.appointmentFinancialSnapshot.groupBy.mockResolvedValue([]);
      prisma.ledgerEntry.groupBy.mockResolvedValue([]);
      prisma.appointment.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { amount: null },
      });
      prisma.appointment.count.mockResolvedValue(0);
      prisma.withdrawalRequest.groupBy
        .mockResolvedValueOnce([
          {
            status: WithdrawalStatus.APPROVED,
            _count: { _all: 1 },
            _sum: { amount: d('1000.00') },
          },
        ])
        .mockResolvedValueOnce([
          {
            status: WithdrawalStatus.PENDING_REVIEW,
            _count: { _all: 1 },
            _sum: { amount: d('1500.00') },
          },
        ]);
      prisma.withdrawalDebit.aggregate
        .mockResolvedValueOnce({
          _count: { _all: 1 },
          _sum: { amount: d('400.00') },
        })
        .mockResolvedValueOnce({
          _count: { _all: 2 },
          _sum: { amount: d('1500.00') },
        });

      const result = await service.overview({});
      expect(result.withdrawals.scope).toBe('ASTROLOGER_EARNINGS');
      expect(result.withdrawals.reservedAmount).toBe('1000.00');
      expect(result.withdrawals.debitAmount).toBe('400.00');
      expect(result.withdrawals.byStatus.APPROVED).toEqual({
        count: 1,
        amount: '1000.00',
      });
      expect(result.customerReferralPayouts.scope).toBe('CUSTOMER_REFERRAL');
      expect(result.customerReferralPayouts.reservedAmount).toBe('1500.00');
      expect(result.customerReferralPayouts.debitAmount).toBe('1500.00');
      expect(result.payoutsCombined.scope).toBe(
        'ASTROLOGER_EARNINGS_PLUS_CUSTOMER_REFERRAL',
      );
      expect(result.payoutsCombined.reservedAmount).toBe('2500.00');
      expect(result.payoutsCombined.debitCount).toBe(3);
      expect(result.payoutsCombined.debitAmount).toBe('1900.00');
      expect(result.notes.withdrawalsAreAstrologerEarningsOnly).toBe(true);
      expect(result.ledgerByCategory.CUSTOMER_REFERRAL.netAmount).toBe('0.00');
    });

    it('rejects reversed date ranges', async () => {
      await expect(
        service.overview({
          from: '2026-10-02T00:00:00.000Z',
          to: '2026-10-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/strictly before/);
    });
  });

  describe('listLedger', () => {
    it('applies filters, pagination, and stable ordering', async () => {
      prisma.ledgerEntry.count.mockResolvedValue(1);
      prisma.ledgerEntry.findMany.mockResolvedValue([
        {
          id: 'le-1',
          idempotencyKey: 'snap:s1:ASTROLOGER_EARNING:CREDIT',
          category: LedgerCategory.ASTROLOGER_EARNING,
          kind: LedgerEntryKind.CREDIT,
          amount: d('800.00'),
          currency: 'LKR',
          userId: 'u1',
          appointmentId: 'a1',
          consultationId: 'c1',
          paymentId: 'p1',
          snapshotId: 's1',
          reversesEntryId: null,
          createdAt: new Date('2026-10-01T12:00:00.000Z'),
        },
      ]);

      const result = await service.listLedger({
        userId: 'u1',
        kind: LedgerEntryKind.CREDIT,
        page: 2,
        pageSize: 10,
      });
      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.items[0]).toMatchObject({
        id: 'le-1',
        amount: '800.00',
        userId: 'u1',
        reversesEntryId: null,
      });
      expect(result.items[0]).not.toHaveProperty('passwordHash');
      expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            kind: LedgerEntryKind.CREDIT,
          }),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 10,
          take: 10,
        }),
      );
    });
  });

  describe('reconcile', () => {
    beforeEach(() => {
      prisma.walletAccount.count.mockResolvedValue(1);
      prisma.walletAccount.findMany.mockResolvedValue([
        { userId: 'u1', availableBalance: d('800.00') },
      ]);
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        {
          userId: 'u1',
          kind: LedgerEntryKind.CREDIT,
          _sum: { amount: d('800.00') },
        },
      ]);
      prisma.platformAccount.findUnique.mockResolvedValue({
        id: PLATFORM_ACCOUNT_ID,
        availableBalance: d('200.00'),
      });
      prisma.appointmentFinancialSnapshot.count.mockResolvedValue(1);
      prisma.appointmentFinancialSnapshot.findMany.mockResolvedValue([
        {
          id: 's1',
          appointmentId: 'a1',
          status: FinancialSnapshotStatus.RECORDED,
          grossAmount: d('1000.00'),
          astrologerAmount: d('800.00'),
          platformAmount: d('200.00'),
          customerReferrerUserId: null,
          customerReferralAmount: d('0.00'),
          astrologerReferrerUserId: null,
          astrologerReferralAmount: d('0.00'),
          astrologer: { userId: 'u1' },
          ledgerEntries: [],
        },
      ]);
      prisma.ledgerEntry.findMany.mockResolvedValue([]);
    });

    it('reports no issues for consistent wallets and legitimate RECORDED', async () => {
      // Second groupBy call is for platform residual.
      prisma.ledgerEntry.groupBy
        .mockResolvedValueOnce([
          {
            userId: 'u1',
            kind: LedgerEntryKind.CREDIT,
            _sum: { amount: d('800.00') },
          },
        ])
        .mockResolvedValueOnce([
          {
            kind: LedgerEntryKind.CREDIT,
            _sum: { amount: d('200.00') },
          },
        ]);

      const result = await service.reconcile();
      expect(result.complete).toBe(true);
      expect(result.issueCount).toBe(0);
      expect(result.notes.noMutationsPerformed).toBe(true);
    });

    it('detects wallet mismatch and incomplete POSTED credits', async () => {
      prisma.walletAccount.findMany.mockResolvedValue([
        { userId: 'u1', availableBalance: d('999.00') },
      ]);
      prisma.ledgerEntry.groupBy
        .mockResolvedValueOnce([
          {
            userId: 'u1',
            kind: LedgerEntryKind.CREDIT,
            _sum: { amount: d('800.00') },
          },
        ])
        .mockResolvedValueOnce([
          { kind: LedgerEntryKind.CREDIT, _sum: { amount: d('200.00') } },
        ]);
      prisma.appointmentFinancialSnapshot.findMany.mockResolvedValue([
        {
          id: 's1',
          appointmentId: 'a1',
          status: FinancialSnapshotStatus.POSTED,
          grossAmount: d('1000.00'),
          astrologerAmount: d('800.00'),
          platformAmount: d('200.00'),
          customerReferrerUserId: null,
          customerReferralAmount: d('0.00'),
          astrologerReferrerUserId: null,
          astrologerReferralAmount: d('0.00'),
          astrologer: { userId: 'u1' },
          ledgerEntries: [
            {
              id: 'c1',
              kind: LedgerEntryKind.CREDIT,
              category: LedgerCategory.ASTROLOGER_EARNING,
              amount: d('800.00'),
              userId: 'u1',
              reversesEntryId: null,
            },
          ],
        },
      ]);

      const result = await service.reconcile();
      expect(result.issueCount).toBeGreaterThanOrEqual(2);
      expect(result.issues.map((i) => i.code)).toEqual(
        expect.arrayContaining([
          'WALLET_BALANCE_MISMATCH',
          'POSTED_INCOMPLETE_CREDITS',
        ]),
      );
    });

    it('accepts correct reversals and flags missing DEBITs', async () => {
      prisma.walletAccount.findMany.mockResolvedValue([]);
      prisma.walletAccount.count.mockResolvedValue(0);
      prisma.platformAccount.findUnique.mockResolvedValue({
        availableBalance: d('0.00'),
      });
      // No wallets ⇒ only the platform groupBy runs.
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        { kind: LedgerEntryKind.CREDIT, _sum: { amount: d('200.00') } },
        { kind: LedgerEntryKind.DEBIT, _sum: { amount: d('200.00') } },
      ]);
      prisma.appointmentFinancialSnapshot.findMany.mockResolvedValue([
        {
          id: 's1',
          appointmentId: 'a1',
          status: FinancialSnapshotStatus.REVERSED,
          grossAmount: d('1000.00'),
          astrologerAmount: d('800.00'),
          platformAmount: d('200.00'),
          customerReferrerUserId: null,
          customerReferralAmount: d('0.00'),
          astrologerReferrerUserId: null,
          astrologerReferralAmount: d('0.00'),
          astrologer: { userId: 'u1' },
          ledgerEntries: [
            {
              id: 'c1',
              kind: LedgerEntryKind.CREDIT,
              category: LedgerCategory.ASTROLOGER_EARNING,
              amount: d('800.00'),
              userId: 'u1',
              reversesEntryId: null,
            },
            {
              id: 'c2',
              kind: LedgerEntryKind.CREDIT,
              category: LedgerCategory.PLATFORM_RESIDUAL,
              amount: d('200.00'),
              userId: null,
              reversesEntryId: null,
            },
          ],
        },
      ]);

      const bad = await service.reconcile();
      expect(bad.issues.map((i) => i.code)).toContain(
        'REVERSED_INCOMPLETE_DEBITS',
      );

      prisma.appointmentFinancialSnapshot.findMany.mockResolvedValue([
        {
          id: 's1',
          appointmentId: 'a1',
          status: FinancialSnapshotStatus.REVERSED,
          grossAmount: d('1000.00'),
          astrologerAmount: d('800.00'),
          platformAmount: d('200.00'),
          customerReferrerUserId: null,
          customerReferralAmount: d('0.00'),
          astrologerReferrerUserId: null,
          astrologerReferralAmount: d('0.00'),
          astrologer: { userId: 'u1' },
          ledgerEntries: [
            {
              id: 'c1',
              kind: LedgerEntryKind.CREDIT,
              category: LedgerCategory.ASTROLOGER_EARNING,
              amount: d('800.00'),
              userId: 'u1',
              reversesEntryId: null,
            },
            {
              id: 'c2',
              kind: LedgerEntryKind.CREDIT,
              category: LedgerCategory.PLATFORM_RESIDUAL,
              amount: d('200.00'),
              userId: null,
              reversesEntryId: null,
            },
            {
              id: 'd1',
              kind: LedgerEntryKind.DEBIT,
              category: LedgerCategory.ASTROLOGER_EARNING,
              amount: d('800.00'),
              userId: 'u1',
              reversesEntryId: 'c1',
            },
            {
              id: 'd2',
              kind: LedgerEntryKind.DEBIT,
              category: LedgerCategory.PLATFORM_RESIDUAL,
              amount: d('200.00'),
              userId: null,
              reversesEntryId: 'c2',
            },
          ],
        },
      ]);

      const good = await service.reconcile();
      expect(
        good.issues.filter((i) => i.code === 'REVERSED_INCOMPLETE_DEBITS'),
      ).toHaveLength(0);
      expect(
        good.issues.filter((i) => i.code === 'REVERSAL_AMOUNT_MISMATCH'),
      ).toHaveLength(0);
    });

    function consistentLedgerGroups() {
      prisma.ledgerEntry.groupBy
        .mockResolvedValueOnce([
          {
            userId: 'u1',
            kind: LedgerEntryKind.CREDIT,
            _sum: { amount: d('800.00') },
          },
        ])
        .mockResolvedValueOnce([
          {
            kind: LedgerEntryKind.CREDIT,
            _sum: { amount: d('200.00') },
          },
        ]);
    }

    it('treats a cancelled withdrawal as unreserved and flags an unexpected debit', async () => {
      consistentLedgerGroups();
      prisma.withdrawalRequest.count.mockResolvedValue(1);
      prisma.withdrawalRequest.findMany.mockResolvedValueOnce([
        {
          id: 'w-cancel',
          status: WithdrawalStatus.CANCELLED,
          amount: d('1000.00'),
          currency: 'LKR',
          debit: null,
          destinationAccountLast4: '9012',
          destinationAccountCiphertext: 'cipher',
        },
      ]);

      const clean = await service.reconcile();
      const cleanCodes = clean.issues.map((issue) => issue.code);
      expect(cleanCodes).not.toContain('CANCELLED_WITHDRAWAL_HAS_DEBIT');
      expect(cleanCodes).not.toContain('RESERVED_WITHDRAWAL_HAS_DEBIT');
      expect(cleanCodes).not.toContain('WITHDRAWAL_RESERVATION_EXCEEDS_WALLET');

      consistentLedgerGroups();
      prisma.withdrawalRequest.findMany.mockResolvedValueOnce([
        {
          id: 'w-cancel',
          status: WithdrawalStatus.CANCELLED,
          amount: d('1000.00'),
          currency: 'LKR',
          debit: { id: 'deb-1', amount: d('1000.00'), currency: 'LKR' },
          destinationAccountLast4: '9012',
          destinationAccountCiphertext: 'cipher',
        },
      ]);
      const flagged = await service.reconcile();
      expect(flagged.issues.map((issue) => issue.code)).toContain(
        'CANCELLED_WITHDRAWAL_HAS_DEBIT',
      );
      expect(flagged.issues.map((issue) => issue.code)).not.toContain(
        'RESERVED_WITHDRAWAL_HAS_DEBIT',
      );
      expect(flagged.notes.noMutationsPerformed).toBe(true);
    });

    it('flags customer referral reservations above eligible earnings without repairing them', async () => {
      consistentLedgerGroups();
      prisma.ledgerEntry.findMany.mockImplementation(
        (args: { where?: { category?: string } }) => {
          if (args?.where?.category === LedgerCategory.CUSTOMER_REFERRAL) {
            return Promise.resolve([
              {
                userId: 'u1',
                kind: LedgerEntryKind.CREDIT,
                amount: d('500.00'),
              },
            ]);
          }
          return Promise.resolve([]);
        },
      );
      prisma.withdrawalRequest.groupBy.mockImplementation(
        (args: { where?: { purpose?: string } }) => {
          if (args?.where?.purpose === 'CUSTOMER_REFERRAL') {
            return Promise.resolve([
              { userId: 'u1', _sum: { amount: d('1000.00') } },
            ]);
          }
          return Promise.resolve([]);
        },
      );

      prisma.withdrawalRequest.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'payout-1',
            userId: 'u1',
            amount: d('1000.00'),
            user: { name: 'Kamal Silva' },
          },
        ]);

      const result = await service.reconcile();
      expect(result.issues.map((issue) => issue.code)).toContain(
        'CUSTOMER_PAYOUT_RESERVATION_EXCEEDS_ELIGIBLE',
      );
      const unpayable = result.issues.find(
        (issue) => issue.code === 'CUSTOMER_PAYOUT_UNPAYABLE',
      );
      expect(unpayable).toEqual({
        code: 'CUSTOMER_PAYOUT_UNPAYABLE',
        message: expect.stringContaining(
          'Cancel it to release the reservation',
        ),
        references: {
          withdrawalId: 'payout-1',
          beneficiaryUserId: 'u1',
          beneficiaryName: 'Kamal Silva',
          amount: '1000.00',
          shortfallAmount: '500.00',
        },
      });
      expect(result.notes.noMutationsPerformed).toBe(true);
      expect(prisma.withdrawalRequest.update).toBeUndefined();
      prisma.ledgerEntry.findMany.mockResolvedValue([]);
      prisma.withdrawalRequest.groupBy.mockResolvedValue([]);
    });
  });

  describe('listAttentionCases', () => {
    it('returns paginated attention rows without unrelated fields', async () => {
      prisma.appointment.count.mockResolvedValue(1);
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: 'a1',
          consultationId: 'c1',
          status: 'NO_SHOW_ASTROLOGER',
          amount: d('1000.00'),
          currency: 'LKR',
          refundObligation: 'FULL_REFUND_DUE',
          refundObligationRecordedAt: new Date('2026-10-01T10:00:00.000Z'),
          manualReviewRequired: false,
          cancelReason: null,
          cancelledAt: null,
          noShowRecordedAt: new Date('2026-10-01T10:00:00.000Z'),
          payments: [
            {
              id: 'p1',
              status: 'PAID',
              amount: d('1000.00'),
              currency: 'LKR',
            },
          ],
          consultation: {
            id: 'c1',
            status: 'COMPLETED',
            completedAt: null,
          },
          financialSnapshot: null,
          ledgerEntries: [],
        },
      ]);

      const result = await service.listAttentionCases({
        page: 1,
        pageSize: 20,
      });
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        appointmentId: 'a1',
        refundObligation: 'FULL_REFUND_DUE',
        ledger: { hasCredits: false, hasReversals: false },
      });
      expect(result.items[0]).not.toHaveProperty('customer');
      expect(prisma.appointment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                OR: [
                  { refundObligation: { not: null } },
                  { manualReviewRequired: true },
                ],
              },
            ]),
          }),
        }),
      );
    });
  });
});

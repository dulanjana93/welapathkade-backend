/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest mock idioms */
import {
  AppointmentStatus,
  FinancialSnapshotStatus,
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
} from '@prisma/client';
import { FinancialLedgerService } from './financial-ledger.service';
import { PLATFORM_ACCOUNT_ID } from './ledger.constants';
import { SETTLEMENT_HOLD_MS } from './settlement.constants';

const completedAt = new Date('2026-10-01T10:00:00.000Z');
const holdExpiresAt = new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS);
const afterHold = new Date(holdExpiresAt.getTime() + 1000);

function d(value: string) {
  return new Prisma.Decimal(value);
}

function recordedSnapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'snap-1',
    appointmentId: 'apt-1',
    consultationId: 'c-1',
    paymentId: 'pay-1',
    currency: 'LKR',
    grossAmount: d('1000.00'),
    basis: 'GROSS_CONSULTATION_AMOUNT',
    astrologerId: 'ap-1',
    astrologerPercent: d('80.00'),
    astrologerAmount: d('800.00'),
    customerReferrerUserId: 'cust-ref',
    customerReferralPercent: d('3.00'),
    customerReferralAmount: d('30.00'),
    astrologerReferrerUserId: 'astro-ref',
    astrologerReferralPercent: d('3.00'),
    astrologerReferralAmount: d('30.00'),
    platformPercent: d('14.00'),
    platformAmount: d('140.00'),
    status: FinancialSnapshotStatus.RECORDED,
    completedAt,
    holdExpiresAt,
    postedAt: null,
    reversedAt: null,
    createdAt: afterHold,
    appointment: {
      id: 'apt-1',
      status: AppointmentStatus.COMPLETED,
      refundObligation: null,
      manualReviewRequired: false,
    },
    astrologer: { userId: 'astro-user' },
    ledgerEntries: [],
    ...overrides,
  };
}

describe('FinancialLedgerService', () => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    appointmentFinancialSnapshot: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    ledgerEntry: {
      create: jest.fn(),
      count: jest.fn(),
    },
    walletAccount: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
    platformAccount: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
  };

  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) =>
      Promise.resolve(work(tx)),
    ),
    appointmentFinancialSnapshot: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    ledgerEntry: {
      findMany: jest.fn(),
    },
    walletAccount: {
      findUnique: jest.fn(),
    },
    platformAccount: {
      findUnique: jest.fn(),
    },
  };

  const service = new FinancialLedgerService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ id: 'locked' }]);
    tx.appointmentFinancialSnapshot.updateMany.mockResolvedValue({ count: 1 });
    tx.ledgerEntry.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: `le-${String(data.category)}`, ...data }),
    );
    tx.ledgerEntry.count.mockResolvedValue(0);
    tx.walletAccount.upsert.mockResolvedValue({});
    tx.platformAccount.upsert.mockResolvedValue({});
    tx.walletAccount.update.mockResolvedValue({});
    tx.platformAccount.update.mockResolvedValue({});
  });

  it('posts both referral commissions, astrologer earning, and platform residual', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot(),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({
      ok: true,
      posted: true,
      snapshotId: 'snap-1',
      entryCount: 4,
    });

    const categories = tx.ledgerEntry.create.mock.calls.map(
      (call: [{ data: { category: LedgerCategory; userId: string | null } }]) =>
        call[0].data.category,
    );
    expect(categories).toEqual(
      expect.arrayContaining([
        LedgerCategory.ASTROLOGER_EARNING,
        LedgerCategory.CUSTOMER_REFERRAL,
        LedgerCategory.ASTROLOGER_REFERRAL,
        LedgerCategory.PLATFORM_RESIDUAL,
      ]),
    );

    const platformCreate = tx.ledgerEntry.create.mock.calls.find(
      (call: [{ data: { category: LedgerCategory } }]) =>
        call[0].data.category === LedgerCategory.PLATFORM_RESIDUAL,
    ) as [{ data: { userId: string | null; amount: Prisma.Decimal } }];
    expect(platformCreate[0].data.userId).toBeNull();
    expect(platformCreate[0].data.amount.equals(d('140.00'))).toBe(true);

    expect(tx.platformAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PLATFORM_ACCOUNT_ID },
        create: expect.objectContaining({
          id: PLATFORM_ACCOUNT_ID,
          availableBalance: expect.any(Prisma.Decimal),
        }),
      }),
    );
    expect(tx.walletAccount.upsert).toHaveBeenCalledTimes(3);
  });

  it('allocates customer-referrer-only and leaves residual on platform', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        astrologerReferrerUserId: null,
        astrologerReferralPercent: d('0.00'),
        astrologerReferralAmount: d('0.00'),
        platformPercent: d('17.00'),
        platformAmount: d('170.00'),
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result.ok && result.posted).toBe(true);
    if (!result.ok) return;
    expect(result.entryCount).toBe(3);

    const categories = tx.ledgerEntry.create.mock.calls.map(
      (call: [{ data: { category: LedgerCategory } }]) => call[0].data.category,
    );
    expect(categories).not.toContain(LedgerCategory.ASTROLOGER_REFERRAL);
    expect(categories).toContain(LedgerCategory.CUSTOMER_REFERRAL);
  });

  it('allocates astrologer-referrer-only', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        customerReferrerUserId: null,
        customerReferralPercent: d('0.00'),
        customerReferralAmount: d('0.00'),
        platformPercent: d('17.00'),
        platformAmount: d('170.00'),
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result.ok && result.posted).toBe(true);
    if (!result.ok) return;
    expect(result.entryCount).toBe(3);
    const categories = tx.ledgerEntry.create.mock.calls.map(
      (call: [{ data: { category: LedgerCategory } }]) => call[0].data.category,
    );
    expect(categories).toContain(LedgerCategory.ASTROLOGER_REFERRAL);
    expect(categories).not.toContain(LedgerCategory.CUSTOMER_REFERRAL);
  });

  it('posts no-referral split with full residual on platform account', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        customerReferrerUserId: null,
        customerReferralPercent: d('0.00'),
        customerReferralAmount: d('0.00'),
        astrologerReferrerUserId: null,
        astrologerReferralPercent: d('0.00'),
        astrologerReferralAmount: d('0.00'),
        platformPercent: d('20.00'),
        platformAmount: d('200.00'),
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result.ok && result.posted).toBe(true);
    if (!result.ok) return;
    expect(result.entryCount).toBe(2);
    expect(tx.walletAccount.upsert).toHaveBeenCalledTimes(1);
    expect(tx.platformAccount.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects amount mismatch before writing ledger rows', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        platformAmount: d('999.00'),
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('blocks posting when refund obligation or manual review is set', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        appointment: {
          id: 'apt-1',
          status: AppointmentStatus.COMPLETED,
          refundObligation: 'FULL_REFUND_DUE',
          manualReviewRequired: false,
        },
      }),
    );
    let result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({
      ok: false,
      reason: 'APPOINTMENT_BLOCKS_POSTING',
    });

    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        appointment: {
          id: 'apt-1',
          status: AppointmentStatus.COMPLETED,
          refundObligation: null,
          manualReviewRequired: true,
        },
      }),
    );
    result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({
      ok: false,
      reason: 'APPOINTMENT_BLOCKS_POSTING',
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('is idempotent when snapshot is already POSTED with complete credits', async () => {
    const completeCredits = [
      {
        id: 'c1',
        category: LedgerCategory.ASTROLOGER_EARNING,
        amount: d('800.00'),
        userId: 'astro-user',
      },
      {
        id: 'c2',
        category: LedgerCategory.PLATFORM_RESIDUAL,
        amount: d('140.00'),
        userId: null,
      },
      {
        id: 'c3',
        category: LedgerCategory.CUSTOMER_REFERRAL,
        amount: d('30.00'),
        userId: 'cust-ref',
      },
      {
        id: 'c4',
        category: LedgerCategory.ASTROLOGER_REFERRAL,
        amount: d('30.00'),
        userId: 'astro-ref',
      },
    ];
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        status: FinancialSnapshotStatus.POSTED,
        ledgerEntries: completeCredits,
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({
      ok: true,
      posted: false,
      snapshotId: 'snap-1',
      entryCount: 4,
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('rejects POSTED snapshots with incomplete credit sets', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        status: FinancialSnapshotStatus.POSTED,
        ledgerEntries: [
          {
            id: 'c1',
            category: LedgerCategory.ASTROLOGER_EARNING,
            amount: d('800.00'),
            userId: 'astro-user',
          },
        ],
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({ ok: false, reason: 'INCOMPLETE_LEDGER' });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('does not mark RECORDED→POSTED when only partial credits exist', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        ledgerEntries: [
          {
            id: 'c1',
            category: LedgerCategory.ASTROLOGER_EARNING,
            amount: d('800.00'),
            userId: 'astro-user',
          },
        ],
      }),
    );

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({ ok: false, reason: 'INCOMPLETE_LEDGER' });
    expect(tx.appointmentFinancialSnapshot.updateMany).not.toHaveBeenCalled();
  });

  it('blocks posting while the settlement hold is still active', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot(),
    );

    const result = await service.postSnapshot(
      'snap-1',
      new Date(holdExpiresAt.getTime() - 1000),
    );
    expect(result).toEqual({ ok: false, reason: 'SETTLEMENT_HOLD_ACTIVE' });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('locks snapshot and appointment rows before posting', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot(),
    );
    await service.postSnapshot('snap-1', afterHold);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('treats concurrent unique violations as success only when POSTED is complete', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot(),
    );
    tx.ledgerEntry.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.appointmentFinancialSnapshot.findUnique.mockResolvedValue({
      ...recordedSnapshot({
        status: FinancialSnapshotStatus.POSTED,
        ledgerEntries: [
          {
            id: 'c1',
            category: LedgerCategory.ASTROLOGER_EARNING,
            amount: d('800.00'),
            userId: 'astro-user',
          },
          {
            id: 'c2',
            category: LedgerCategory.PLATFORM_RESIDUAL,
            amount: d('140.00'),
            userId: null,
          },
          {
            id: 'c3',
            category: LedgerCategory.CUSTOMER_REFERRAL,
            amount: d('30.00'),
            userId: 'cust-ref',
          },
          {
            id: 'c4',
            category: LedgerCategory.ASTROLOGER_REFERRAL,
            amount: d('30.00'),
            userId: 'astro-ref',
          },
        ],
      }),
      astrologer: { userId: 'astro-user' },
    });

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({
      ok: true,
      posted: false,
      snapshotId: 'snap-1',
      entryCount: 4,
    });
  });

  it('does not treat P2002 as success when committed POSTED ledger is incomplete', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot(),
    );
    tx.ledgerEntry.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.appointmentFinancialSnapshot.findUnique.mockResolvedValue({
      ...recordedSnapshot({
        status: FinancialSnapshotStatus.POSTED,
        ledgerEntries: [
          {
            id: 'c1',
            category: LedgerCategory.ASTROLOGER_EARNING,
            amount: d('800.00'),
            userId: 'astro-user',
          },
        ],
      }),
      astrologer: { userId: 'astro-user' },
    });

    const result = await service.postSnapshot('snap-1', afterHold);
    expect(result).toEqual({ ok: false, reason: 'INCOMPLETE_LEDGER' });
  });

  it('rolls back the transaction callback when a mid-post write fails', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        customerReferrerUserId: null,
        customerReferralAmount: d('0.00'),
        customerReferralPercent: d('0.00'),
        astrologerReferrerUserId: null,
        astrologerReferralAmount: d('0.00'),
        astrologerReferralPercent: d('0.00'),
        platformPercent: d('20.00'),
        platformAmount: d('200.00'),
      }),
    );
    tx.ledgerEntry.create
      .mockResolvedValueOnce({
        id: 'le-1',
        category: LedgerCategory.ASTROLOGER_EARNING,
      })
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(service.postSnapshot('snap-1', afterHold)).rejects.toThrow(
      'disk full',
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('postDueSnapshots only selects RECORDED hold-elapsed unblocked rows', async () => {
    prisma.appointmentFinancialSnapshot.findMany.mockResolvedValue([
      { id: 'snap-1' },
    ]);
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot(),
    );

    const result = await service.postDueSnapshots(afterHold);
    expect(result.posted).toBe(1);
    expect(prisma.appointmentFinancialSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: FinancialSnapshotStatus.RECORDED,
          holdExpiresAt: { lte: afterHold },
          appointment: expect.objectContaining({
            status: AppointmentStatus.COMPLETED,
            refundObligation: null,
            manualReviewRequired: false,
          }),
        }),
      }),
    );
  });

  it('reverses posted credits with linked DEBITs when refund obligation exists', async () => {
    const credits = [
      {
        id: 'credit-astro',
        category: LedgerCategory.ASTROLOGER_EARNING,
        kind: LedgerEntryKind.CREDIT,
        amount: d('800.00'),
        currency: 'LKR',
        userId: 'astro-user',
      },
      {
        id: 'credit-platform',
        category: LedgerCategory.PLATFORM_RESIDUAL,
        kind: LedgerEntryKind.CREDIT,
        amount: d('200.00'),
        currency: 'LKR',
        userId: null,
      },
    ];
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        status: FinancialSnapshotStatus.POSTED,
        customerReferrerUserId: null,
        customerReferralAmount: d('0.00'),
        customerReferralPercent: d('0.00'),
        astrologerReferrerUserId: null,
        astrologerReferralAmount: d('0.00'),
        astrologerReferralPercent: d('0.00'),
        platformPercent: d('20.00'),
        platformAmount: d('200.00'),
        appointment: {
          id: 'apt-1',
          refundObligation: 'FULL_REFUND_DUE',
        },
        ledgerEntries: credits,
      }),
    );
    tx.ledgerEntry.count.mockResolvedValue(2);

    const result = await service.reversePostedSnapshotForRefundObligation(
      'apt-1',
      afterHold,
    );
    expect(result).toEqual({
      ok: true,
      reversed: true,
      snapshotId: 'snap-1',
      entryCount: 2,
    });

    const debitCreates = tx.ledgerEntry.create.mock.calls.map(
      (
        call: [
          {
            data: {
              kind: LedgerEntryKind;
              reversesEntryId: string;
              amount: Prisma.Decimal;
            };
          },
        ],
      ) => call[0].data,
    );
    expect(debitCreates).toHaveLength(2);
    expect(
      debitCreates.every((row) => row.kind === LedgerEntryKind.DEBIT),
    ).toBe(true);
    expect(debitCreates.map((row) => row.reversesEntryId)).toEqual([
      'credit-astro',
      'credit-platform',
    ]);
    expect(tx.walletAccount.update).toHaveBeenCalled();
    expect(tx.platformAccount.update).toHaveBeenCalled();
    expect(tx.appointmentFinancialSnapshot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: FinancialSnapshotStatus.REVERSED,
        }),
      }),
    );
  });

  it('does not reverse without a refund obligation', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        status: FinancialSnapshotStatus.POSTED,
        appointment: { id: 'apt-1', refundObligation: null },
        ledgerEntries: [
          { id: 'c1', category: LedgerCategory.ASTROLOGER_EARNING },
        ],
      }),
    );

    const result = await service.reversePostedSnapshotForRefundObligation(
      'apt-1',
      afterHold,
    );
    expect(result).toEqual({ ok: false, reason: 'NO_REFUND_OBLIGATION' });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('does not reverse an unposted RECORDED snapshot', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        appointment: { id: 'apt-1', refundObligation: 'FULL_REFUND_DUE' },
      }),
    );

    const result = await service.reversePostedSnapshotForRefundObligation(
      'apt-1',
      afterHold,
    );
    expect(result).toEqual({ ok: false, reason: 'NOT_POSTED' });
  });

  it('duplicate reversal attempts are idempotent', async () => {
    tx.appointmentFinancialSnapshot.findUnique.mockResolvedValue(
      recordedSnapshot({
        status: FinancialSnapshotStatus.REVERSED,
        appointment: { id: 'apt-1', refundObligation: 'FULL_REFUND_DUE' },
      }),
    );
    tx.ledgerEntry.count.mockResolvedValue(2);

    const result = await service.reversePostedSnapshotForRefundObligation(
      'apt-1',
      afterHold,
    );
    expect(result).toEqual({
      ok: true,
      reversed: false,
      snapshotId: 'snap-1',
      entryCount: 2,
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('reconcileUserLedger matches CREDIT minus DEBIT', async () => {
    prisma.ledgerEntry.findMany.mockResolvedValue([
      { amount: d('800.00'), kind: LedgerEntryKind.CREDIT },
      { amount: d('800.00'), kind: LedgerEntryKind.DEBIT },
      { amount: d('30.00'), kind: LedgerEntryKind.CREDIT },
    ]);
    const total = await service.reconcileUserLedger('astro-user');
    expect(total.equals(d('30.00'))).toBe(true);
  });
});

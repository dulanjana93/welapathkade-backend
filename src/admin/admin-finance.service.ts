import { Injectable } from '@nestjs/common';
import {
  FinancialSnapshotStatus,
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
  WithdrawalPurpose,
  WithdrawalStatus,
  type AppointmentFinancialSnapshot,
  type LedgerEntry,
} from '@prisma/client';
import { toMoneyString } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_ACCOUNT_ID } from '../settlement/ledger.constants';
import { roundMoney } from '../settlement/settlement-allocation';
import { ZERO_MONEY } from '../settlement/settlement.constants';
import {
  hasDateBound,
  parseUtcHalfOpenRange,
  prismaDateTimeFilter,
} from './admin-finance.date';
import type {
  AdminAttentionCasesQueryDto,
  AdminLedgerQueryDto,
  FinanceDateRangeQueryDto,
} from './dto/admin-finance.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_RECONCILE_WALLETS = 500;
const MAX_RECONCILE_SNAPSHOTS = 500;
const MAX_ISSUE_DETAILS = 50;

export type FinanceIssueCode =
  | 'WALLET_BALANCE_MISMATCH'
  | 'PLATFORM_BALANCE_MISMATCH'
  | 'POSTED_INCOMPLETE_CREDITS'
  | 'REVERSED_INCOMPLETE_DEBITS'
  | 'RECORDED_UNEXPECTED_CREDITS'
  | 'REVERSAL_AMOUNT_MISMATCH'
  | 'ORPHAN_LEDGER_SNAPSHOT'
  | 'PAID_WITHDRAWAL_MISSING_DEBIT'
  | 'WITHDRAWAL_DEBIT_MISMATCH'
  | 'RESERVED_WITHDRAWAL_HAS_DEBIT'
  | 'REJECTED_WITHDRAWAL_HAS_DEBIT'
  | 'CANCELLED_WITHDRAWAL_HAS_DEBIT'
  | 'WITHDRAWAL_RESERVATION_EXCEEDS_WALLET'
  | 'CUSTOMER_PAYOUT_RESERVATION_EXCEEDS_ELIGIBLE'
  | 'CUSTOMER_PAYOUT_UNPAYABLE'
  | 'WITHDRAWAL_DESTINATION_SNAPSHOT_MISSING';

type ExpectedCredit = {
  category: LedgerCategory;
  amount: Prisma.Decimal;
  userId: string | null;
};

@Injectable()
export class AdminFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * D1 — aggregate financial overview.
   * Date range (UTC half-open) applies to snapshot.createdAt, ledger.createdAt,
   * refundObligationRecordedAt, and noShowRecordedAt for manual-review cases.
   */
  async overview(query: FinanceDateRangeQueryDto) {
    const range = parseUtcHalfOpenRange(query);
    const snapCreated = hasDateBound(range)
      ? { createdAt: prismaDateTimeFilter(range) }
      : {};
    const ledgerCreated = hasDateBound(range)
      ? { createdAt: prismaDateTimeFilter(range) }
      : {};

    const [
      snapshotGroups,
      ledgerGroups,
      refundAgg,
      manualReviewCount,
      withdrawalGroups,
      withdrawalDebits,
      customerWithdrawalGroups,
      customerWithdrawalDebits,
    ] = await Promise.all([
      this.prisma.appointmentFinancialSnapshot.groupBy({
        by: ['status'],
        where: snapCreated,
        _count: { _all: true },
        _sum: { grossAmount: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['category', 'kind'],
        where: ledgerCreated,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.appointment.aggregate({
        where: {
          refundObligation: { not: null },
          ...(hasDateBound(range)
            ? { refundObligationRecordedAt: prismaDateTimeFilter(range) }
            : {}),
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.appointment.count({
        where: {
          manualReviewRequired: true,
          ...(hasDateBound(range)
            ? { noShowRecordedAt: prismaDateTimeFilter(range) }
            : {}),
        },
      }),
      this.prisma.withdrawalRequest.groupBy({
        by: ['status'],
        where: {
          ...ledgerCreated,
          purpose: WithdrawalPurpose.ASTROLOGER_EARNINGS,
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.withdrawalDebit.aggregate({
        where: {
          ...ledgerCreated,
          withdrawalRequest: {
            purpose: WithdrawalPurpose.ASTROLOGER_EARNINGS,
          },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.withdrawalRequest.groupBy({
        by: ['status'],
        where: {
          ...ledgerCreated,
          purpose: WithdrawalPurpose.CUSTOMER_REFERRAL,
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.withdrawalDebit.aggregate({
        where: {
          ...ledgerCreated,
          withdrawalRequest: {
            purpose: WithdrawalPurpose.CUSTOMER_REFERRAL,
          },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const snapshotsByStatus = {
      RECORDED: { count: 0, grossAmount: toMoneyString(0) },
      POSTED: { count: 0, grossAmount: toMoneyString(0) },
      REVERSED: { count: 0, grossAmount: toMoneyString(0) },
    };
    for (const row of snapshotGroups) {
      snapshotsByStatus[row.status] = {
        count: row._count._all,
        grossAmount: toMoneyString(row._sum.grossAmount ?? ZERO_MONEY),
      };
    }

    const categoryTotals = this.emptyCategoryTotals();
    for (const row of ledgerGroups) {
      const bucket = categoryTotals[row.category];
      const amount = row._sum.amount ?? ZERO_MONEY;
      if (row.kind === LedgerEntryKind.CREDIT) {
        bucket.credits = bucket.credits.plus(amount);
        bucket.creditCount += row._count._all;
      } else {
        bucket.debits = bucket.debits.plus(amount);
        bucket.debitCount += row._count._all;
      }
    }

    return {
      dateRange: {
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        interval: 'UTC_HALF_OPEN' as const,
      },
      notes: {
        postedDoesNotMeanWithdrawn: true,
        internalReversalIsNotExternalRefund: true,
        platformResidualIsNotUserWallet: true,
        withdrawalApprovalIsNotPayment: true,
        withdrawalDebitIsNotEarningReversal: true,
        withdrawalsAreAstrologerEarningsOnly: true,
      },
      snapshotsByStatus,
      postedGrossAmount: snapshotsByStatus.POSTED.grossAmount,
      ledgerByCategory: Object.fromEntries(
        Object.entries(categoryTotals).map(([category, totals]) => [
          category,
          {
            creditAmount: toMoneyString(totals.credits),
            debitAmount: toMoneyString(totals.debits),
            netAmount: toMoneyString(totals.credits.minus(totals.debits)),
            creditCount: totals.creditCount,
            debitCount: totals.debitCount,
          },
        ]),
      ),
      refundObligations: {
        count: refundAgg._count._all,
        grossAmount: toMoneyString(refundAgg._sum.amount ?? ZERO_MONEY),
        note: 'Obligation only — not proof an external refund was executed',
      },
      manualReview: {
        count: manualReviewCount,
      },
      withdrawals: this.withdrawalOverview(
        withdrawalGroups,
        withdrawalDebits,
        'ASTROLOGER_EARNINGS',
        'Astrologer earnings withdrawals only. Customer referral payouts are reported separately and are not included in these totals.',
      ),
      customerReferralPayouts: this.withdrawalOverview(
        customerWithdrawalGroups,
        customerWithdrawalDebits,
        'CUSTOMER_REFERRAL',
        'Customer referral payouts only. Astrologer earnings withdrawals are not included in these totals.',
      ),
      payoutsCombined: this.combinePayoutOverviews(
        withdrawalGroups,
        customerWithdrawalGroups,
        withdrawalDebits,
        customerWithdrawalDebits,
      ),
    };
  }

  /** D2 — paginated ledger explorer. */
  async listLedger(query: AdminLedgerQueryDto) {
    const range = parseUtcHalfOpenRange(query);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.LedgerEntryWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.paymentId ? { paymentId: query.paymentId } : {}),
      ...(query.snapshotId ? { snapshotId: query.snapshotId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(hasDateBound(range)
        ? { createdAt: prismaDateTimeFilter(range) }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.ledgerEntry.count({ where }),
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          idempotencyKey: true,
          category: true,
          kind: true,
          amount: true,
          currency: true,
          userId: true,
          appointmentId: true,
          consultationId: true,
          paymentId: true,
          snapshotId: true,
          reversesEntryId: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        category: row.category,
        kind: row.kind,
        amount: toMoneyString(row.amount),
        currency: row.currency,
        userId: row.userId,
        appointmentId: row.appointmentId,
        consultationId: row.consultationId,
        paymentId: row.paymentId,
        snapshotId: row.snapshotId,
        reversesEntryId: row.reversesEntryId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * D3 — read-only reconciliation. Never mutates financial rows.
   * Sign convention: available = sum(CREDIT amounts) − sum(DEBIT amounts).
   */
  async reconcile() {
    const issues: Array<{
      code: FinanceIssueCode;
      message: string;
      references: Record<string, string | null>;
    }> = [];
    let truncated = false;

    const walletCount = await this.prisma.walletAccount.count();
    const wallets = await this.prisma.walletAccount.findMany({
      take: MAX_RECONCILE_WALLETS + 1,
      orderBy: { id: 'asc' },
      select: { userId: true, availableBalance: true },
    });
    if (wallets.length > MAX_RECONCILE_WALLETS) {
      truncated = true;
      wallets.pop();
    }

    const userIds = wallets.map((w) => w.userId);
    const userLedgerGroups =
      userIds.length === 0
        ? []
        : await this.prisma.ledgerEntry.groupBy({
            by: ['userId', 'kind'],
            where: { userId: { in: userIds } },
            _sum: { amount: true },
          });
    const netByUser = new Map<string, Prisma.Decimal>();
    for (const row of userLedgerGroups) {
      if (!row.userId) continue;
      const prev = netByUser.get(row.userId) ?? ZERO_MONEY;
      const amount = row._sum.amount ?? ZERO_MONEY;
      netByUser.set(
        row.userId,
        row.kind === LedgerEntryKind.CREDIT
          ? prev.plus(amount)
          : prev.minus(amount),
      );
    }
    const withdrawalDebitGroups =
      userIds.length === 0
        ? []
        : await this.prisma.withdrawalDebit.groupBy({
            by: ['userId'],
            where: { userId: { in: userIds } },
            _sum: { amount: true },
          });
    for (const row of withdrawalDebitGroups) {
      const prev = netByUser.get(row.userId) ?? ZERO_MONEY;
      netByUser.set(row.userId, prev.minus(row._sum.amount ?? ZERO_MONEY));
    }
    const reservedGroups =
      userIds.length === 0
        ? []
        : await this.prisma.withdrawalRequest.groupBy({
            by: ['userId'],
            where: {
              userId: { in: userIds },
              status: {
                in: [
                  WithdrawalStatus.PENDING_REVIEW,
                  WithdrawalStatus.APPROVED,
                ],
              },
            },
            _sum: { amount: true },
          });
    const reservedByUser = new Map<string, Prisma.Decimal>();
    for (const row of reservedGroups) {
      reservedByUser.set(row.userId, row._sum.amount ?? ZERO_MONEY);
    }
    for (const wallet of wallets) {
      const expected = netByUser.get(wallet.userId) ?? ZERO_MONEY;
      if (!roundMoney(wallet.availableBalance).equals(roundMoney(expected))) {
        this.pushIssue(issues, {
          code: 'WALLET_BALANCE_MISMATCH',
          message:
            'Wallet availableBalance does not equal ledger CREDIT − DEBIT − withdrawal debits',
          references: {
            userId: wallet.userId,
            availableBalance: toMoneyString(wallet.availableBalance),
            ledgerNet: toMoneyString(expected),
          },
        });
      }
      const reserved = reservedByUser.get(wallet.userId) ?? ZERO_MONEY;
      if (
        roundMoney(reserved).greaterThan(roundMoney(wallet.availableBalance))
      ) {
        this.pushIssue(issues, {
          code: 'WITHDRAWAL_RESERVATION_EXCEEDS_WALLET',
          message:
            'Pending and approved withdrawals reserve more than the wallet available balance',
          references: {
            userId: wallet.userId,
            availableBalance: toMoneyString(wallet.availableBalance),
            reservedAmount: toMoneyString(reserved),
          },
        });
      }
    }

    const platform = await this.prisma.platformAccount.findUnique({
      where: { id: PLATFORM_ACCOUNT_ID },
    });
    const platformGroups = await this.prisma.ledgerEntry.groupBy({
      by: ['kind'],
      where: { category: LedgerCategory.PLATFORM_RESIDUAL },
      _sum: { amount: true },
    });
    let platformNet = ZERO_MONEY;
    for (const row of platformGroups) {
      const amount = row._sum.amount ?? ZERO_MONEY;
      platformNet =
        row.kind === LedgerEntryKind.CREDIT
          ? platformNet.plus(amount)
          : platformNet.minus(amount);
    }
    const platformBalance = platform?.availableBalance ?? ZERO_MONEY;
    if (!roundMoney(platformBalance).equals(roundMoney(platformNet))) {
      this.pushIssue(issues, {
        code: 'PLATFORM_BALANCE_MISMATCH',
        message:
          'Platform availableBalance does not equal PLATFORM_RESIDUAL CREDIT − DEBIT',
        references: {
          platformAccountId: PLATFORM_ACCOUNT_ID,
          availableBalance: toMoneyString(platformBalance),
          ledgerNet: toMoneyString(platformNet),
        },
      });
    }

    const snapshotCount =
      await this.prisma.appointmentFinancialSnapshot.count();
    const snapshots = await this.prisma.appointmentFinancialSnapshot.findMany({
      take: MAX_RECONCILE_SNAPSHOTS + 1,
      orderBy: { id: 'asc' },
      include: {
        astrologer: { select: { userId: true } },
        ledgerEntries: true,
      },
    });
    if (snapshots.length > MAX_RECONCILE_SNAPSHOTS) {
      truncated = true;
      snapshots.pop();
    }

    for (const snapshot of snapshots) {
      this.checkSnapshotInvariants(snapshot, issues);
    }

    // FK normally prevents orphans; still report if a dangling snapshotId appears
    // in an unexpected client/test state. Bounded sample of recent entries.
    const recentEntries = await this.prisma.ledgerEntry.findMany({
      take: MAX_RECONCILE_SNAPSHOTS,
      orderBy: { createdAt: 'desc' },
      select: { id: true, snapshotId: true },
    });
    const snapIds = [...new Set(recentEntries.map((e) => e.snapshotId))];
    const existingSnaps =
      snapIds.length === 0
        ? []
        : await this.prisma.appointmentFinancialSnapshot.findMany({
            where: { id: { in: snapIds } },
            select: { id: true },
          });
    const existingSet = new Set(existingSnaps.map((s) => s.id));
    for (const entry of recentEntries) {
      if (!existingSet.has(entry.snapshotId)) {
        this.pushIssue(issues, {
          code: 'ORPHAN_LEDGER_SNAPSHOT',
          message: 'Ledger entry references a missing snapshot',
          references: {
            ledgerEntryId: entry.id,
            snapshotId: entry.snapshotId,
          },
        });
      }
    }

    if (walletCount > MAX_RECONCILE_WALLETS) truncated = true;
    if (snapshotCount > MAX_RECONCILE_SNAPSHOTS) truncated = true;

    const withdrawalCount = await this.prisma.withdrawalRequest.count();
    const withdrawalRows = await this.prisma.withdrawalRequest.findMany({
      take: MAX_RECONCILE_SNAPSHOTS + 1,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        status: true,
        amount: true,
        currency: true,
        userId: true,
        destinationAccountLast4: true,
        destinationAccountCiphertext: true,
        debit: { select: { id: true, amount: true, currency: true } },
      },
    });
    if (withdrawalRows.length > MAX_RECONCILE_SNAPSHOTS) {
      truncated = true;
      withdrawalRows.pop();
    }
    if (withdrawalCount > MAX_RECONCILE_SNAPSHOTS) truncated = true;
    for (const row of withdrawalRows) {
      const reserved =
        row.status === WithdrawalStatus.PENDING_REVIEW ||
        row.status === WithdrawalStatus.APPROVED;
      if (row.status === WithdrawalStatus.PAID && !row.debit) {
        this.pushIssue(issues, {
          code: 'PAID_WITHDRAWAL_MISSING_DEBIT',
          message: 'Paid withdrawal has no withdrawal debit',
          references: { withdrawalId: row.id },
        });
      }
      if (row.status === WithdrawalStatus.PAID && row.debit) {
        if (
          !roundMoney(row.debit.amount).equals(roundMoney(row.amount)) ||
          row.debit.currency !== row.currency
        ) {
          this.pushIssue(issues, {
            code: 'WITHDRAWAL_DEBIT_MISMATCH',
            message:
              'Withdrawal debit amount or currency does not match the paid request',
            references: {
              withdrawalId: row.id,
              debitId: row.debit.id,
            },
          });
        }
      }
      if (reserved && row.debit) {
        this.pushIssue(issues, {
          code: 'RESERVED_WITHDRAWAL_HAS_DEBIT',
          message: 'Pending or approved withdrawal already has a payout debit',
          references: { withdrawalId: row.id, debitId: row.debit.id },
        });
      }
      if (row.status === WithdrawalStatus.REJECTED && row.debit) {
        this.pushIssue(issues, {
          code: 'REJECTED_WITHDRAWAL_HAS_DEBIT',
          message: 'Rejected withdrawal has a payout debit',
          references: { withdrawalId: row.id, debitId: row.debit.id },
        });
      }
      if (row.status === WithdrawalStatus.CANCELLED && row.debit) {
        this.pushIssue(issues, {
          code: 'CANCELLED_WITHDRAWAL_HAS_DEBIT',
          message: 'Cancelled withdrawal has a payout debit',
          references: { withdrawalId: row.id, debitId: row.debit.id },
        });
      }
      if (!row.destinationAccountLast4 || !row.destinationAccountCiphertext) {
        this.pushIssue(issues, {
          code: 'WITHDRAWAL_DESTINATION_SNAPSHOT_MISSING',
          message:
            'Withdrawal is missing the encrypted destination snapshot taken at request time',
          references: { withdrawalId: row.id },
        });
      }
    }

    if (userIds.length > 0) {
      const [referralRows, customerReserved, customerPaid] = await Promise.all([
        this.prisma.ledgerEntry.findMany({
          where: {
            userId: { in: userIds },
            category: LedgerCategory.CUSTOMER_REFERRAL,
          },
          select: { userId: true, kind: true, amount: true },
        }),
        this.prisma.withdrawalRequest.groupBy({
          by: ['userId'],
          where: {
            userId: { in: userIds },
            purpose: WithdrawalPurpose.CUSTOMER_REFERRAL,
            status: {
              in: [WithdrawalStatus.PENDING_REVIEW, WithdrawalStatus.APPROVED],
            },
          },
          _sum: { amount: true },
        }),
        this.prisma.withdrawalDebit.groupBy({
          by: ['userId'],
          where: {
            userId: { in: userIds },
            withdrawalRequest: {
              purpose: WithdrawalPurpose.CUSTOMER_REFERRAL,
            },
          },
          _sum: { amount: true },
        }),
      ]);
      const referralNet = new Map<string, Prisma.Decimal>();
      for (const row of referralRows) {
        if (!row.userId) continue;
        const prev = referralNet.get(row.userId) ?? ZERO_MONEY;
        const amount = row.amount ?? ZERO_MONEY;
        referralNet.set(
          row.userId,
          row.kind === LedgerEntryKind.CREDIT
            ? prev.plus(amount)
            : prev.minus(amount),
        );
      }
      const paidByUser = new Map<string, Prisma.Decimal>();
      for (const row of customerPaid) {
        paidByUser.set(row.userId, row._sum.amount ?? ZERO_MONEY);
      }
      for (const row of customerReserved) {
        const reserved = row._sum.amount ?? ZERO_MONEY;
        const net = referralNet.get(row.userId) ?? ZERO_MONEY;
        const paid = paidByUser.get(row.userId) ?? ZERO_MONEY;
        const eligible = Prisma.Decimal.max(ZERO_MONEY, net.minus(paid));
        if (roundMoney(reserved).greaterThan(roundMoney(eligible))) {
          this.pushIssue(issues, {
            code: 'CUSTOMER_PAYOUT_RESERVATION_EXCEEDS_ELIGIBLE',
            message:
              'Active customer referral payout reservations exceed eligible referral earnings',
            references: {
              userId: row.userId,
              reservedAmount: toMoneyString(reserved),
              eligibleAmount: toMoneyString(eligible),
            },
          });
        }
      }

      const approvedPayouts = await this.prisma.withdrawalRequest.findMany({
        where: {
          userId: { in: userIds },
          purpose: WithdrawalPurpose.CUSTOMER_REFERRAL,
          status: WithdrawalStatus.APPROVED,
        },
        select: {
          id: true,
          userId: true,
          amount: true,
          user: { select: { name: true } },
        },
      });
      for (const request of approvedPayouts) {
        const net = referralNet.get(request.userId) ?? ZERO_MONEY;
        const paid = paidByUser.get(request.userId) ?? ZERO_MONEY;
        const eligible = Prisma.Decimal.max(ZERO_MONEY, net.minus(paid));
        const amount = roundMoney(request.amount);
        if (amount.greaterThan(roundMoney(eligible))) {
          this.pushIssue(issues, {
            code: 'CUSTOMER_PAYOUT_UNPAYABLE',
            message:
              'Approved customer referral payout exceeds remaining eligible earnings. Cancel it to release the reservation. Do not mark it paid.',
            references: {
              withdrawalId: request.id,
              beneficiaryUserId: request.userId,
              beneficiaryName: request.user.name,
              amount: toMoneyString(amount),
              shortfallAmount: toMoneyString(amount.minus(eligible)),
            },
          });
        }
      }
    }

    return {
      complete: !truncated,
      scanned: {
        wallets: wallets.length,
        walletTotal: walletCount,
        snapshots: snapshots.length,
        snapshotTotal: snapshotCount,
        recentLedgerEntries: recentEntries.length,
        withdrawals: withdrawalRows.length,
        withdrawalTotal: withdrawalCount,
      },
      issueCount: issues.length,
      issues: issues.slice(0, MAX_ISSUE_DETAILS),
      issuesTruncated: issues.length > MAX_ISSUE_DETAILS,
      notes: {
        signConvention:
          'available = ledger CREDIT − ledger DEBIT − withdrawal debits (earning reversals stay on LedgerEntry)',
        recordedWithoutCreditsIsValid: true,
        noMutationsPerformed: true,
        withdrawalReservationIsNotADebit: true,
      },
    };
  }

  /** D4 — refund-obligation / manual-review attention list. */
  async listAttentionCases(query: AdminAttentionCasesQueryDto) {
    const range = parseUtcHalfOpenRange(query);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const dateFilter = hasDateBound(range)
      ? {
          OR: [
            { refundObligationRecordedAt: prismaDateTimeFilter(range) },
            { noShowRecordedAt: prismaDateTimeFilter(range) },
            { cancelledAt: prismaDateTimeFilter(range) },
          ],
        }
      : {};

    const where: Prisma.AppointmentWhereInput = {
      AND: [
        {
          OR: [
            { refundObligation: { not: null } },
            { manualReviewRequired: true },
          ],
        },
        dateFilter,
      ],
    };

    const [total, rows] = await Promise.all([
      this.prisma.appointment.count({ where }),
      this.prisma.appointment.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          payments: {
            select: { id: true, status: true, amount: true, currency: true },
            take: 1,
          },
          consultation: {
            select: {
              id: true,
              status: true,
              completedAt: true,
            },
          },
          financialSnapshot: {
            select: {
              id: true,
              status: true,
              grossAmount: true,
              currency: true,
            },
          },
          ledgerEntries: {
            select: { id: true, kind: true },
          },
        },
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => {
        const payment = row.payments[0] ?? null;
        const credits = row.ledgerEntries.filter(
          (e) => e.kind === LedgerEntryKind.CREDIT,
        ).length;
        const debits = row.ledgerEntries.filter(
          (e) => e.kind === LedgerEntryKind.DEBIT,
        ).length;
        return {
          appointmentId: row.id,
          consultationId: row.consultationId,
          appointmentStatus: row.status,
          consultationStatus: row.consultation.status,
          amount: toMoneyString(row.amount),
          currency: row.currency,
          refundObligation: row.refundObligation,
          refundObligationRecordedAt:
            row.refundObligationRecordedAt?.toISOString() ?? null,
          manualReviewRequired: row.manualReviewRequired,
          cancelReason: row.cancelReason,
          cancelledAt: row.cancelledAt?.toISOString() ?? null,
          noShowRecordedAt: row.noShowRecordedAt?.toISOString() ?? null,
          completedAt: row.consultation.completedAt?.toISOString() ?? null,
          payment: payment
            ? {
                id: payment.id,
                status: payment.status,
                amount: toMoneyString(payment.amount),
                currency: payment.currency,
              }
            : null,
          snapshot: row.financialSnapshot
            ? {
                id: row.financialSnapshot.id,
                status: row.financialSnapshot.status,
                grossAmount: toMoneyString(row.financialSnapshot.grossAmount),
                currency: row.financialSnapshot.currency,
              }
            : null,
          ledger: {
            creditCount: credits,
            debitCount: debits,
            hasCredits: credits > 0,
            hasReversals: debits > 0,
          },
          notes: {
            obligationIsNotExternalRefund: true,
            listingDoesNotMutateState: true,
          },
        };
      }),
    };
  }

  private withdrawalOverview(
    groups: Array<{
      status: WithdrawalStatus;
      _count: { _all: number };
      _sum: { amount: Prisma.Decimal | null };
    }>,
    debits: {
      _count: { _all: number };
      _sum: { amount: Prisma.Decimal | null };
    },
    scope: 'ASTROLOGER_EARNINGS' | 'CUSTOMER_REFERRAL',
    note: string,
  ) {
    const byStatus = {
      PENDING_REVIEW: { count: 0, amount: toMoneyString(0) },
      APPROVED: { count: 0, amount: toMoneyString(0) },
      REJECTED: { count: 0, amount: toMoneyString(0) },
      PAID: { count: 0, amount: toMoneyString(0) },
      CANCELLED: { count: 0, amount: toMoneyString(0) },
    };
    for (const row of groups) {
      byStatus[row.status] = {
        count: row._count._all,
        amount: toMoneyString(row._sum.amount ?? ZERO_MONEY),
      };
    }
    const reserved = new Prisma.Decimal(byStatus.PENDING_REVIEW.amount).plus(
      byStatus.APPROVED.amount,
    );
    return {
      scope,
      byStatus,
      reservedAmount: toMoneyString(reserved),
      paidAmount: byStatus.PAID.amount,
      debitCount: debits._count._all,
      debitAmount: toMoneyString(debits._sum.amount ?? ZERO_MONEY),
      note,
    };
  }

  private combinePayoutOverviews(
    astrologerGroups: Array<{
      status: WithdrawalStatus;
      _count: { _all: number };
      _sum: { amount: Prisma.Decimal | null };
    }>,
    customerGroups: Array<{
      status: WithdrawalStatus;
      _count: { _all: number };
      _sum: { amount: Prisma.Decimal | null };
    }>,
    astrologerDebits: {
      _count: { _all: number };
      _sum: { amount: Prisma.Decimal | null };
    },
    customerDebits: {
      _count: { _all: number };
      _sum: { amount: Prisma.Decimal | null };
    },
  ) {
    const astrologer = this.withdrawalOverview(
      astrologerGroups,
      astrologerDebits,
      'ASTROLOGER_EARNINGS',
      '',
    );
    const customer = this.withdrawalOverview(
      customerGroups,
      customerDebits,
      'CUSTOMER_REFERRAL',
      '',
    );
    const statuses = [
      WithdrawalStatus.PENDING_REVIEW,
      WithdrawalStatus.APPROVED,
      WithdrawalStatus.REJECTED,
      WithdrawalStatus.PAID,
      WithdrawalStatus.CANCELLED,
    ] as const;
    const byStatus = {
      PENDING_REVIEW: { count: 0, amount: '0.00' },
      APPROVED: { count: 0, amount: '0.00' },
      REJECTED: { count: 0, amount: '0.00' },
      PAID: { count: 0, amount: '0.00' },
      CANCELLED: { count: 0, amount: '0.00' },
    };
    for (const status of statuses) {
      byStatus[status] = {
        count:
          astrologer.byStatus[status].count + customer.byStatus[status].count,
        amount: toMoneyString(
          new Prisma.Decimal(astrologer.byStatus[status].amount).plus(
            customer.byStatus[status].amount,
          ),
        ),
      };
    }
    return {
      scope: 'ASTROLOGER_EARNINGS_PLUS_CUSTOMER_REFERRAL' as const,
      byStatus,
      reservedAmount: toMoneyString(
        new Prisma.Decimal(astrologer.reservedAmount).plus(
          customer.reservedAmount,
        ),
      ),
      paidAmount: toMoneyString(
        new Prisma.Decimal(astrologer.paidAmount).plus(customer.paidAmount),
      ),
      debitCount: astrologer.debitCount + customer.debitCount,
      debitAmount: toMoneyString(
        new Prisma.Decimal(astrologer.debitAmount).plus(customer.debitAmount),
      ),
      note: 'Sum of the astrologer earnings and customer referral payout figures. It does not replace either purpose total.',
    };
  }

  private emptyCategoryTotals(): Record<
    LedgerCategory,
    {
      credits: Prisma.Decimal;
      debits: Prisma.Decimal;
      creditCount: number;
      debitCount: number;
    }
  > {
    const empty = () => ({
      credits: new Prisma.Decimal(0),
      debits: new Prisma.Decimal(0),
      creditCount: 0,
      debitCount: 0,
    });
    return {
      ASTROLOGER_EARNING: empty(),
      CUSTOMER_REFERRAL: empty(),
      ASTROLOGER_REFERRAL: empty(),
      PLATFORM_RESIDUAL: empty(),
    };
  }

  private expectedCredits(
    snapshot: AppointmentFinancialSnapshot & {
      astrologer: { userId: string };
    },
  ): ExpectedCredit[] {
    const lines: ExpectedCredit[] = [
      {
        category: LedgerCategory.ASTROLOGER_EARNING,
        amount: roundMoney(snapshot.astrologerAmount),
        userId: snapshot.astrologer.userId,
      },
      {
        category: LedgerCategory.PLATFORM_RESIDUAL,
        amount: roundMoney(snapshot.platformAmount),
        userId: null,
      },
    ];
    if (
      snapshot.customerReferrerUserId &&
      snapshot.customerReferralAmount.greaterThan(0)
    ) {
      lines.push({
        category: LedgerCategory.CUSTOMER_REFERRAL,
        amount: roundMoney(snapshot.customerReferralAmount),
        userId: snapshot.customerReferrerUserId,
      });
    }
    if (
      snapshot.astrologerReferrerUserId &&
      snapshot.astrologerReferralAmount.greaterThan(0)
    ) {
      lines.push({
        category: LedgerCategory.ASTROLOGER_REFERRAL,
        amount: roundMoney(snapshot.astrologerReferralAmount),
        userId: snapshot.astrologerReferrerUserId,
      });
    }
    return lines.filter((line) => line.amount.greaterThan(0));
  }

  private checkSnapshotInvariants(
    snapshot: AppointmentFinancialSnapshot & {
      astrologer: { userId: string };
      ledgerEntries: LedgerEntry[];
    },
    issues: Array<{
      code: FinanceIssueCode;
      message: string;
      references: Record<string, string | null>;
    }>,
  ): void {
    const credits = snapshot.ledgerEntries.filter(
      (e) => e.kind === LedgerEntryKind.CREDIT,
    );
    const debits = snapshot.ledgerEntries.filter(
      (e) => e.kind === LedgerEntryKind.DEBIT,
    );
    const expected = this.expectedCredits(snapshot);

    if (snapshot.status === FinancialSnapshotStatus.RECORDED) {
      if (credits.length > 0) {
        this.pushIssue(issues, {
          code: 'RECORDED_UNEXPECTED_CREDITS',
          message:
            'RECORDED snapshot has ledger CREDITS (incomplete/corrupt posting)',
          references: {
            snapshotId: snapshot.id,
            appointmentId: snapshot.appointmentId,
            creditCount: String(credits.length),
          },
        });
      }
      return;
    }

    if (snapshot.status === FinancialSnapshotStatus.POSTED) {
      if (!this.creditsMatch(credits, expected)) {
        this.pushIssue(issues, {
          code: 'POSTED_INCOMPLETE_CREDITS',
          message: 'POSTED snapshot CREDITS do not match frozen allocations',
          references: {
            snapshotId: snapshot.id,
            appointmentId: snapshot.appointmentId,
            expectedCount: String(expected.length),
            actualCount: String(credits.length),
          },
        });
      }
      return;
    }

    if (snapshot.status === FinancialSnapshotStatus.REVERSED) {
      if (!this.creditsMatch(credits, expected)) {
        this.pushIssue(issues, {
          code: 'POSTED_INCOMPLETE_CREDITS',
          message: 'REVERSED snapshot CREDITS do not match frozen allocations',
          references: {
            snapshotId: snapshot.id,
            appointmentId: snapshot.appointmentId,
          },
        });
      }
      if (debits.length !== credits.length) {
        this.pushIssue(issues, {
          code: 'REVERSED_INCOMPLETE_DEBITS',
          message: 'REVERSED snapshot is missing linked DEBIT reversals',
          references: {
            snapshotId: snapshot.id,
            appointmentId: snapshot.appointmentId,
            creditCount: String(credits.length),
            debitCount: String(debits.length),
          },
        });
        return;
      }
      for (const credit of credits) {
        const debit = debits.find((d) => d.reversesEntryId === credit.id);
        if (
          !debit ||
          !roundMoney(debit.amount).equals(roundMoney(credit.amount))
        ) {
          this.pushIssue(issues, {
            code: 'REVERSAL_AMOUNT_MISMATCH',
            message: 'Reversal DEBIT missing or amount differs from CREDIT',
            references: {
              snapshotId: snapshot.id,
              creditEntryId: credit.id,
              debitEntryId: debit?.id ?? null,
            },
          });
        }
      }
    }
  }

  private creditsMatch(
    credits: Array<{
      category: LedgerCategory;
      amount: Prisma.Decimal;
      userId: string | null;
    }>,
    expected: ExpectedCredit[],
  ): boolean {
    if (credits.length !== expected.length) return false;
    return expected.every((line) =>
      credits.some(
        (credit) =>
          credit.category === line.category &&
          credit.userId === line.userId &&
          roundMoney(credit.amount).equals(line.amount),
      ),
    );
  }

  private pushIssue(
    issues: Array<{
      code: FinanceIssueCode;
      message: string;
      references: Record<string, string | null>;
    }>,
    issue: {
      code: FinanceIssueCode;
      message: string;
      references: Record<string, string | null>;
    },
  ): void {
    issues.push(issue);
  }
}

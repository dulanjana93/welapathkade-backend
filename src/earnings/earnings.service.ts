import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
  UserRole,
  type User,
} from '@prisma/client';
import { toMoneyString } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import { ZERO_MONEY } from '../settlement/settlement.constants';
import {
  USER_EARNINGS_CATEGORIES,
  type EarningsLedgerQueryDto,
} from './dto/earnings-ledger-query.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

type CategoryBucket = {
  creditAmount: Prisma.Decimal;
  debitAmount: Prisma.Decimal;
  creditCount: number;
  debitCount: number;
};

/**
 * Authenticated read-only wallet/ledger for PUBLIC and ASTROLOGER users.
 * Ownership is always the JWT user id — clients cannot query another wallet.
 */
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: User) {
    this.assertEarningsRole(user);

    const [wallet, groups] = await Promise.all([
      this.prisma.walletAccount.findUnique({ where: { userId: user.id } }),
      this.prisma.ledgerEntry.groupBy({
        by: ['category', 'kind'],
        where: {
          userId: user.id,
          category: { in: USER_EARNINGS_CATEGORIES },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const totals = this.emptyTotals();
    for (const row of groups) {
      const bucket = totals[row.category];
      if (!bucket) continue;
      const amount = row._sum.amount ?? ZERO_MONEY;
      if (row.kind === LedgerEntryKind.CREDIT) {
        bucket.creditAmount = bucket.creditAmount.plus(amount);
        bucket.creditCount += row._count._all;
      } else {
        bucket.debitAmount = bucket.debitAmount.plus(amount);
        bucket.debitCount += row._count._all;
      }
    }

    const available = wallet?.availableBalance ?? ZERO_MONEY;
    const currency = wallet?.currency ?? 'LKR';

    return {
      availableBalance: toMoneyString(available),
      currency,
      byCategory: Object.fromEntries(
        USER_EARNINGS_CATEGORIES.map((category) => {
          const t = totals[category];
          return [
            category,
            {
              creditAmount: toMoneyString(t.creditAmount),
              debitAmount: toMoneyString(t.debitAmount),
              netAmount: toMoneyString(t.creditAmount.minus(t.debitAmount)),
              creditCount: t.creditCount,
              debitCount: t.debitCount,
            },
          ];
        }),
      ),
      notes: {
        availableIsInternalWalletNotPayout: true,
        platformResidualNeverIncluded: true,
        attributionDoesNotGuaranteeCommission: true,
      },
    };
  }

  async listLedger(user: User, query: EarningsLedgerQueryDto) {
    this.assertEarningsRole(user);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    if (
      query.category != null &&
      !USER_EARNINGS_CATEGORIES.includes(query.category)
    ) {
      throw new ForbiddenException('Category not available for user earnings');
    }

    const where: Prisma.LedgerEntryWhereInput = {
      userId: user.id,
      category: query.category
        ? query.category
        : { in: USER_EARNINGS_CATEGORIES },
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
          category: true,
          kind: true,
          amount: true,
          currency: true,
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
      items: rows.map((row) => {
        const signed =
          row.kind === LedgerEntryKind.CREDIT
            ? row.amount
            : row.amount.negated();
        return {
          id: row.id,
          category: row.category,
          kind: row.kind,
          amount: toMoneyString(row.amount),
          signedAmount: toMoneyString(signed),
          currency: row.currency,
          appointmentId: row.appointmentId,
          consultationId: row.consultationId,
          paymentId: row.paymentId,
          snapshotId: row.snapshotId,
          reversesEntryId: row.reversesEntryId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  private assertEarningsRole(user: User): void {
    if (user.role !== UserRole.PUBLIC && user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException(
        'Earnings are only available for public and astrologer accounts',
      );
    }
  }

  private emptyTotals(): Record<LedgerCategory, CategoryBucket> {
    const empty = (): CategoryBucket => ({
      creditAmount: new Prisma.Decimal(0),
      debitAmount: new Prisma.Decimal(0),
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
}

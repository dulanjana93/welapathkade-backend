import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  FinancialSnapshotStatus,
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
  type AppointmentFinancialSnapshot,
  type LedgerEntry,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { allocationsReconcile, roundMoney } from './settlement-allocation';
import { ZERO_MONEY } from './settlement.constants';
import { ledgerIdempotencyKey, PLATFORM_ACCOUNT_ID } from './ledger.constants';

export type PostLedgerResult =
  | { ok: true; posted: boolean; snapshotId: string; entryCount: number }
  | {
      ok: false;
      reason:
        | 'SNAPSHOT_NOT_FOUND'
        | 'ALREADY_REVERSED'
        | 'APPOINTMENT_BLOCKS_POSTING'
        | 'SETTLEMENT_HOLD_ACTIVE'
        | 'AMOUNT_MISMATCH'
        | 'INCOMPLETE_LEDGER';
    };

export type ReverseLedgerResult =
  | { ok: true; reversed: boolean; snapshotId: string; entryCount: number }
  | {
      ok: false;
      reason:
        | 'SNAPSHOT_NOT_FOUND'
        | 'NOT_POSTED'
        | 'ALREADY_REVERSED'
        | 'NO_REFUND_OBLIGATION'
        | 'NO_CREDITS'
        | 'INCOMPLETE_REVERSAL';
    };

type Tx = Prisma.TransactionClient;

type AllocationLine = {
  category: LedgerCategory;
  amount: Prisma.Decimal;
  userId: string | null;
};

type SnapshotForPost = AppointmentFinancialSnapshot & {
  appointment: {
    id: string;
    status: AppointmentStatus;
    refundObligation: string | null;
    manualReviewRequired: boolean;
  };
  astrologer: { userId: string };
  ledgerEntries: LedgerEntry[];
};

/**
 * Phase B: post immutable snapshot allocations to an append-only ledger and
 * user/platform available balances. Does not perform bank transfers or payouts.
 *
 * Availability rule: Phase A only creates RECORDED snapshots after the 24h
 * settlement hold and when refund/manual-review blocks are clear. Posting
 * rechecks hold + blockers under row locks, then credits AVAILABLE balance.
 */
@Injectable()
export class FinancialLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Post CREDIT ledger entries + wallet increments for a RECORDED snapshot.
   * Entire operation is one transaction. Snapshot + appointment rows are locked
   * FOR UPDATE so concurrent lifecycle updates that touch the appointment are
   * serialized with the eligibility recheck. Unique (snapshotId, category, kind)
   * prevents duplicate credits.
   */
  async postSnapshot(
    snapshotId: string,
    now: Date = new Date(),
  ): Promise<PostLedgerResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockSnapshotRow(tx, snapshotId);

        const head = await tx.appointmentFinancialSnapshot.findUnique({
          where: { id: snapshotId },
          select: { appointmentId: true },
        });
        if (!head) {
          return { ok: false, reason: 'SNAPSHOT_NOT_FOUND' };
        }

        await this.lockAppointmentRow(tx, head.appointmentId);

        const snapshot = await this.loadSnapshotForPost(tx, snapshotId);
        if (!snapshot) {
          return { ok: false, reason: 'SNAPSHOT_NOT_FOUND' };
        }
        if (snapshot.status === FinancialSnapshotStatus.REVERSED) {
          return { ok: false, reason: 'ALREADY_REVERSED' };
        }

        const expected = this.buildCreditLines(
          snapshot,
          snapshot.astrologer.userId,
        ).filter((line) => line.amount.greaterThan(0));
        if (!this.linesReconcile(snapshot, expected)) {
          return { ok: false, reason: 'AMOUNT_MISMATCH' };
        }

        if (snapshot.status === FinancialSnapshotStatus.POSTED) {
          if (!this.creditsMatchExpected(snapshot.ledgerEntries, expected)) {
            return { ok: false, reason: 'INCOMPLETE_LEDGER' };
          }
          return {
            ok: true,
            posted: false,
            snapshotId,
            entryCount: snapshot.ledgerEntries.length,
          };
        }

        // Recheck eligibility under the appointment lock — do not trust the
        // earlier RECORDED decision alone (hold / refund / manual review).
        if (snapshot.holdExpiresAt.getTime() > now.getTime()) {
          return { ok: false, reason: 'SETTLEMENT_HOLD_ACTIVE' };
        }
        const apt = snapshot.appointment;
        if (
          apt.status !== AppointmentStatus.COMPLETED ||
          apt.refundObligation ||
          apt.manualReviewRequired
        ) {
          return { ok: false, reason: 'APPOINTMENT_BLOCKS_POSTING' };
        }

        // Recovery: complete credits exist but status stuck at RECORDED.
        // Never mark POSTED unless the full expected set is present.
        if (snapshot.ledgerEntries.length > 0) {
          if (!this.creditsMatchExpected(snapshot.ledgerEntries, expected)) {
            return { ok: false, reason: 'INCOMPLETE_LEDGER' };
          }
          await tx.appointmentFinancialSnapshot.updateMany({
            where: {
              id: snapshotId,
              status: FinancialSnapshotStatus.RECORDED,
            },
            data: {
              status: FinancialSnapshotStatus.POSTED,
              postedAt: now,
            },
          });
          return {
            ok: true,
            posted: false,
            snapshotId,
            entryCount: snapshot.ledgerEntries.length,
          };
        }

        let entryCount = 0;
        for (const line of expected) {
          await tx.ledgerEntry.create({
            data: {
              idempotencyKey: ledgerIdempotencyKey(
                snapshotId,
                line.category,
                'CREDIT',
              ),
              category: line.category,
              kind: LedgerEntryKind.CREDIT,
              amount: line.amount,
              currency: snapshot.currency,
              userId: line.userId,
              appointmentId: snapshot.appointmentId,
              consultationId: snapshot.consultationId,
              paymentId: snapshot.paymentId,
              snapshotId,
            },
          });
          await this.creditBalance(tx, line, snapshot.currency);
          entryCount += 1;
        }

        const claimed = await tx.appointmentFinancialSnapshot.updateMany({
          where: {
            id: snapshotId,
            status: FinancialSnapshotStatus.RECORDED,
          },
          data: {
            status: FinancialSnapshotStatus.POSTED,
            postedAt: now,
          },
        });
        if (claimed.count !== 1) {
          // Should be unreachable under FOR UPDATE; abort so the TX rolls back.
          throw new Error('concurrent post: snapshot claim lost under lock');
        }

        return { ok: true, posted: true, snapshotId, entryCount };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.resolvePostAfterUniqueConflict(snapshotId);
      }
      throw error;
    }
  }

  /**
   * Append DEBIT reversals for a POSTED snapshot when a refund obligation
   * exists. Does NOT mean an external refund was paid — only that internal
   * available balances are clawed back. Idempotent via unique DEBIT keys and
   * reversesEntryId.
   *
   * Prerequisite: Appointment.refundObligation must be set. There is no
   * confirmed external refund event in the system today; callers must not
   * treat this as "customer was refunded".
   */
  async reversePostedSnapshotForRefundObligation(
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<ReverseLedgerResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockAppointmentRow(tx, appointmentId);

        const head = await tx.appointmentFinancialSnapshot.findUnique({
          where: { appointmentId },
          select: { id: true },
        });
        if (!head) {
          return { ok: false, reason: 'SNAPSHOT_NOT_FOUND' };
        }
        await this.lockSnapshotRow(tx, head.id);

        const snapshot = await tx.appointmentFinancialSnapshot.findUnique({
          where: { appointmentId },
          include: {
            appointment: {
              select: { refundObligation: true },
            },
            ledgerEntries: {
              where: { kind: LedgerEntryKind.CREDIT },
            },
          },
        });
        if (!snapshot) {
          return { ok: false, reason: 'SNAPSHOT_NOT_FOUND' };
        }
        if (snapshot.status === FinancialSnapshotStatus.REVERSED) {
          const count = await tx.ledgerEntry.count({
            where: { snapshotId: snapshot.id, kind: LedgerEntryKind.DEBIT },
          });
          return {
            ok: true,
            reversed: false,
            snapshotId: snapshot.id,
            entryCount: count,
          };
        }
        if (snapshot.status !== FinancialSnapshotStatus.POSTED) {
          return { ok: false, reason: 'NOT_POSTED' };
        }
        if (!snapshot.appointment.refundObligation) {
          return { ok: false, reason: 'NO_REFUND_OBLIGATION' };
        }
        if (snapshot.ledgerEntries.length === 0) {
          return { ok: false, reason: 'NO_CREDITS' };
        }

        let entryCount = 0;
        for (const credit of snapshot.ledgerEntries) {
          const created = await this.postReversalDebit(tx, snapshot, credit);
          if (created) entryCount += 1;
        }

        const debitCount = await tx.ledgerEntry.count({
          where: { snapshotId: snapshot.id, kind: LedgerEntryKind.DEBIT },
        });
        if (debitCount !== snapshot.ledgerEntries.length) {
          return { ok: false, reason: 'INCOMPLETE_REVERSAL' };
        }

        await tx.appointmentFinancialSnapshot.updateMany({
          where: {
            id: snapshot.id,
            status: FinancialSnapshotStatus.POSTED,
          },
          data: {
            status: FinancialSnapshotStatus.REVERSED,
            reversedAt: now,
          },
        });

        return {
          ok: true,
          reversed: entryCount > 0,
          snapshotId: snapshot.id,
          entryCount: debitCount,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing =
          await this.prisma.appointmentFinancialSnapshot.findUnique({
            where: { appointmentId },
            include: {
              ledgerEntries: {
                where: { kind: LedgerEntryKind.DEBIT },
              },
            },
          });
        if (existing?.status === FinancialSnapshotStatus.REVERSED) {
          return {
            ok: true,
            reversed: false,
            snapshotId: existing.id,
            entryCount: existing.ledgerEntries.length,
          };
        }
      }
      throw error;
    }
  }

  /**
   * Sweep: post all RECORDED snapshots whose appointments still allow posting.
   * Each postSnapshot rechecks hold + blockers under row locks.
   */
  async postDueSnapshots(
    now: Date = new Date(),
    take = 50,
  ): Promise<{ posted: number; skipped: number; errors: string[] }> {
    const result = { posted: 0, skipped: 0, errors: [] as string[] };
    let rows: Array<{ id: string }>;
    try {
      rows = await this.prisma.appointmentFinancialSnapshot.findMany({
        where: {
          status: FinancialSnapshotStatus.RECORDED,
          holdExpiresAt: { lte: now },
          appointment: {
            status: AppointmentStatus.COMPLETED,
            refundObligation: null,
            manualReviewRequired: false,
          },
        },
        select: { id: true },
        take,
        orderBy: { holdExpiresAt: 'asc' },
      });
    } catch (error) {
      result.errors.push(
        `query: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    for (const row of rows) {
      try {
        const outcome = await this.postSnapshot(row.id, now);
        if (outcome.ok && outcome.posted) result.posted += 1;
        else result.skipped += 1;
      } catch (error) {
        result.errors.push(
          `${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  /** Sum of CREDIT − DEBIT for a user (for reconciliation tests/tools). */
  async reconcileUserLedger(userId: string): Promise<Prisma.Decimal> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { userId },
      select: { amount: true, kind: true },
    });
    return entries.reduce((acc, e) => {
      return e.kind === LedgerEntryKind.CREDIT
        ? acc.plus(e.amount)
        : acc.minus(e.amount);
    }, new Prisma.Decimal(0));
  }

  async getWalletAvailable(userId: string): Promise<Prisma.Decimal> {
    const wallet = await this.prisma.walletAccount.findUnique({
      where: { userId },
    });
    return wallet?.availableBalance ?? ZERO_MONEY;
  }

  async getPlatformAvailable(): Promise<Prisma.Decimal> {
    const row = await this.prisma.platformAccount.findUnique({
      where: { id: PLATFORM_ACCOUNT_ID },
    });
    return row?.availableBalance ?? ZERO_MONEY;
  }

  /**
   * Explicit service boundary for future admin/refund tooling.
   * Requires refundObligation; does not confirm external money movement.
   */
  async reverseOrThrow(appointmentId: string, now?: Date) {
    const result = await this.reversePostedSnapshotForRefundObligation(
      appointmentId,
      now,
    );
    if (!result.ok) {
      throw new BadRequestException(`Cannot reverse ledger: ${result.reason}`);
    }
    return result;
  }

  /**
   * After a unique-constraint conflict, only treat the post as done when the
   * committed row is POSTED with the complete expected CREDIT set.
   */
  private async resolvePostAfterUniqueConflict(
    snapshotId: string,
  ): Promise<PostLedgerResult> {
    const existing = await this.prisma.appointmentFinancialSnapshot.findUnique({
      where: { id: snapshotId },
      include: {
        astrologer: { select: { userId: true } },
        ledgerEntries: {
          where: { kind: LedgerEntryKind.CREDIT },
        },
      },
    });
    if (!existing) {
      return { ok: false, reason: 'SNAPSHOT_NOT_FOUND' };
    }
    if (existing.status === FinancialSnapshotStatus.REVERSED) {
      return { ok: false, reason: 'ALREADY_REVERSED' };
    }
    if (existing.status !== FinancialSnapshotStatus.POSTED) {
      return { ok: false, reason: 'INCOMPLETE_LEDGER' };
    }
    const expected = this.buildCreditLines(
      existing,
      existing.astrologer.userId,
    ).filter((line) => line.amount.greaterThan(0));
    if (!this.creditsMatchExpected(existing.ledgerEntries, expected)) {
      return { ok: false, reason: 'INCOMPLETE_LEDGER' };
    }
    return {
      ok: true,
      posted: false,
      snapshotId,
      entryCount: existing.ledgerEntries.length,
    };
  }

  private async loadSnapshotForPost(
    tx: Tx,
    snapshotId: string,
  ): Promise<SnapshotForPost | null> {
    return tx.appointmentFinancialSnapshot.findUnique({
      where: { id: snapshotId },
      include: {
        appointment: {
          select: {
            id: true,
            status: true,
            refundObligation: true,
            manualReviewRequired: true,
          },
        },
        astrologer: { select: { userId: true } },
        ledgerEntries: {
          where: { kind: LedgerEntryKind.CREDIT },
        },
      },
    });
  }

  private async lockSnapshotRow(tx: Tx, snapshotId: string): Promise<void> {
    await tx.$queryRaw`
      SELECT \`id\`
      FROM \`AppointmentFinancialSnapshot\`
      WHERE \`id\` = ${snapshotId}
      FOR UPDATE
    `;
  }

  private async lockAppointmentRow(
    tx: Tx,
    appointmentId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT \`id\`
      FROM \`Appointment\`
      WHERE \`id\` = ${appointmentId}
      FOR UPDATE
    `;
  }

  private buildCreditLines(
    snapshot: AppointmentFinancialSnapshot,
    astrologerUserId: string,
  ): AllocationLine[] {
    const lines: AllocationLine[] = [
      {
        category: LedgerCategory.ASTROLOGER_EARNING,
        amount: roundMoney(snapshot.astrologerAmount),
        userId: astrologerUserId,
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
    return lines;
  }

  private creditsMatchExpected(
    credits: Array<{
      category: LedgerCategory;
      amount: Prisma.Decimal;
      userId: string | null;
    }>,
    expected: AllocationLine[],
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

  private linesReconcile(
    snapshot: AppointmentFinancialSnapshot,
    lines: AllocationLine[],
  ): boolean {
    const sum = lines.reduce(
      (acc, line) => acc.plus(line.amount),
      new Prisma.Decimal(0),
    );
    const allocation = {
      grossAmount: roundMoney(snapshot.grossAmount),
      astrologerAmount: roundMoney(snapshot.astrologerAmount),
      customerReferralAmount: roundMoney(snapshot.customerReferralAmount),
      astrologerReferralAmount: roundMoney(snapshot.astrologerReferralAmount),
      platformAmount: roundMoney(snapshot.platformAmount),
    };
    return (
      sum.equals(allocation.grossAmount) &&
      allocationsReconcile({
        basis: 'GROSS_CONSULTATION_AMOUNT',
        grossAmount: allocation.grossAmount,
        astrologerPercent: snapshot.astrologerPercent,
        astrologerAmount: allocation.astrologerAmount,
        customerReferrerUserId: snapshot.customerReferrerUserId,
        customerReferralPercent: snapshot.customerReferralPercent,
        customerReferralAmount: allocation.customerReferralAmount,
        astrologerReferrerUserId: snapshot.astrologerReferrerUserId,
        astrologerReferralPercent: snapshot.astrologerReferralPercent,
        astrologerReferralAmount: allocation.astrologerReferralAmount,
        platformPercent: snapshot.platformPercent,
        platformAmount: allocation.platformAmount,
      })
    );
  }

  private async creditBalance(
    tx: Tx,
    line: AllocationLine,
    currency: string,
  ): Promise<void> {
    if (line.category === LedgerCategory.PLATFORM_RESIDUAL) {
      await tx.platformAccount.upsert({
        where: { id: PLATFORM_ACCOUNT_ID },
        create: {
          id: PLATFORM_ACCOUNT_ID,
          currency,
          availableBalance: line.amount,
        },
        update: { availableBalance: { increment: line.amount } },
      });
      return;
    }
    if (!line.userId) {
      throw new Error(`Missing userId for ${line.category}`);
    }
    await tx.walletAccount.upsert({
      where: { userId: line.userId },
      create: {
        userId: line.userId,
        currency,
        availableBalance: line.amount,
      },
      update: { availableBalance: { increment: line.amount } },
    });
  }

  private async debitBalance(tx: Tx, entry: LedgerEntry): Promise<void> {
    if (entry.category === LedgerCategory.PLATFORM_RESIDUAL) {
      await tx.platformAccount.update({
        where: { id: PLATFORM_ACCOUNT_ID },
        data: { availableBalance: { decrement: entry.amount } },
      });
      return;
    }
    if (!entry.userId) {
      throw new Error(`Missing userId for debit ${entry.category}`);
    }
    await tx.walletAccount.update({
      where: { userId: entry.userId },
      data: { availableBalance: { decrement: entry.amount } },
    });
  }

  /** @returns true when a new DEBIT row was created */
  private async postReversalDebit(
    tx: Tx,
    snapshot: AppointmentFinancialSnapshot,
    credit: LedgerEntry,
  ): Promise<boolean> {
    const amount = roundMoney(credit.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new Error(`Cannot reverse non-positive credit ${credit.id}`);
    }
    try {
      await tx.ledgerEntry.create({
        data: {
          idempotencyKey: ledgerIdempotencyKey(
            snapshot.id,
            credit.category,
            'DEBIT',
          ),
          category: credit.category,
          kind: LedgerEntryKind.DEBIT,
          amount,
          currency: credit.currency,
          userId: credit.userId,
          appointmentId: snapshot.appointmentId,
          consultationId: snapshot.consultationId,
          paymentId: snapshot.paymentId,
          snapshotId: snapshot.id,
          reversesEntryId: credit.id,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
    await this.debitBalance(tx, { ...credit, amount });
    return true;
  }
}

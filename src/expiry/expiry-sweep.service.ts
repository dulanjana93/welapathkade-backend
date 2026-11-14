import { Injectable, Optional } from '@nestjs/common';
import { OccupancyService } from '../availability/occupancy.service';
import { expirePendingConsultations } from '../consultations/consultation-expiry';
import { PrismaService } from '../prisma/prisma.service';
import { FinancialLedgerService } from '../settlement/financial-ledger.service';
import { FinancialSnapshotService } from '../settlement/financial-snapshot.service';
import { ConsultationAttachmentsService } from '../consultations/consultation-attachments.service';
import { PayHereRefundService } from '../payments/payhere-refund.service';
import { SavedCardChargeService } from '../payments/saved-card-charge.service';
import { SavedCardService } from '../payments/saved-card.service';
import { SessionCompletionSweepService } from './session-completion-sweep.service';

export type ExpirySweepResult = {
  /** Payment holds flipped PAYMENT_PENDING → PAYMENT_EXPIRED. */
  reservations: number;
  /** Pending payments / attempts of expired holds that were expired. */
  payments: number;
  attempts: number;
  /** Unanswered requests flipped PENDING → EXPIRED. */
  consultations: number;
  /**
   * IN_PROGRESS appointments completed after credential hard-end
   * (SESSION_END via SessionCompletionSweepService). Never-started
   * CONFIRMED appointments are not completed here.
   */
  sessionsCompleted: number;
  /**
   * Phase A financial snapshots created after the 24h settlement hold.
   * Does not credit wallets or referral ledgers.
   */
  financialSnapshotsCreated: number;
  /**
   * Phase B ledger CREDIT posts (RECORDED → POSTED) with wallet increments.
   * Not bank transfers.
   */
  financialLedgersPosted: number;
  /**
   * Unlinked consultation uploads older than the abandonment window.
   * Linked files are not deleted on decline, cancel, or expiry.
   */
  abandonedUploadsRemoved: number;
  /** PayHere refunds started for obligations that had no refund row yet. */
  refundsStarted: number;
  /** Unresolved PayHere refunds checked through Retrieval. */
  refundsReconciled: number;
  /** Uncertain saved-card charges checked through Retrieval. Does not charge again. */
  chargesReconciled: number;
  /**
   * Saved-card registrations the app never completed, failed after
   * ABANDONED_REGISTRATION_MINUTES (slot released). Backstop only.
   */
  cardRegistrationsFailed: number;
  /** One message per failed step; a failed step never blocks the others. */
  errors: string[];
};

/**
 * One pass over everything that is due. It only calls the SAME guarded expiry
 * rules the read paths already use, so there is a single definition of
 * "expired" and nothing here can disagree with it:
 *
 *  - `OccupancyService.expireDueReservations` (30-minute payment holds) and
 *    `expireOrphanedPendingPayments` (recovery for a partially applied run);
 *  - `expirePendingConsultations` (12-hour unanswered requests);
 *  - `SessionCompletionSweepService.completeDueSessions` (IN_PROGRESS past
 *    hard-end → COMPLETED via existing SESSION_END);
 *  - `FinancialSnapshotService.createDueSnapshots` (24h settlement hold →
 *    immutable RECORDED allocation snapshot);
 *  - `FinancialLedgerService.postDueSnapshots` (RECORDED → POSTED ledger
 *    credits + available wallet balances; no bank payouts).
 *
 * Every step is an idempotent, status-guarded UPDATE, so the pass is safe to
 * repeat, to overlap, and to run on several API instances at once. It does not
 * touch accepted proposals, invent no-shows for never-started CONFIRMED
 * appointments, or create refund/earnings records.
 */
@Injectable()
export class ExpirySweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly occupancy: OccupancyService,
    private readonly sessionCompletion: SessionCompletionSweepService,
    private readonly financialSnapshots: FinancialSnapshotService,
    private readonly financialLedger: FinancialLedgerService,
    private readonly attachments: ConsultationAttachmentsService,
    @Optional() private readonly refunds?: PayHereRefundService,
    @Optional() private readonly charges?: SavedCardChargeService,
    @Optional() private readonly savedCards?: SavedCardService,
  ) {}

  async runOnce(now: Date = new Date()): Promise<ExpirySweepResult> {
    const result: ExpirySweepResult = {
      reservations: 0,
      payments: 0,
      attempts: 0,
      consultations: 0,
      sessionsCompleted: 0,
      financialSnapshotsCreated: 0,
      financialLedgersPosted: 0,
      abandonedUploadsRemoved: 0,
      refundsStarted: 0,
      refundsReconciled: 0,
      chargesReconciled: 0,
      cardRegistrationsFailed: 0,
      errors: [],
    };

    try {
      const flipped = await this.occupancy.expireDueReservations(now);
      result.reservations = flipped.appointments;
      result.payments += flipped.payments;
      result.attempts += flipped.attempts;
    } catch (error) {
      result.errors.push(`reservations: ${describe(error)}`);
    }

    try {
      // Always run the recovery step: an earlier pass may have flipped holds
      // and then failed before expiring their payments.
      const healed = await this.occupancy.expireOrphanedPendingPayments(now);
      result.payments += healed.payments;
      result.attempts += healed.attempts;
    } catch (error) {
      result.errors.push(`payment recovery: ${describe(error)}`);
    }

    try {
      result.consultations = await expirePendingConsultations(this.prisma, now);
    } catch (error) {
      result.errors.push(`consultations: ${describe(error)}`);
    }

    try {
      const sessions = await this.sessionCompletion.completeDueSessions(now);
      result.sessionsCompleted = sessions.completed;
      for (const message of sessions.errors) {
        result.errors.push(`sessions: ${message}`);
      }
    } catch (error) {
      result.errors.push(`sessions: ${describe(error)}`);
    }

    try {
      const snapshots = await this.financialSnapshots.createDueSnapshots(now);
      result.financialSnapshotsCreated = snapshots.created;
      for (const message of snapshots.errors) {
        result.errors.push(`financialSnapshots: ${message}`);
      }
    } catch (error) {
      result.errors.push(`financialSnapshots: ${describe(error)}`);
    }

    try {
      const ledgers = await this.financialLedger.postDueSnapshots(now);
      result.financialLedgersPosted = ledgers.posted;
      for (const message of ledgers.errors) {
        result.errors.push(`financialLedgers: ${message}`);
      }
    } catch (error) {
      result.errors.push(`financialLedgers: ${describe(error)}`);
    }

    try {
      result.abandonedUploadsRemoved =
        await this.attachments.purgeAbandonedUploads(now);
    } catch (error) {
      result.errors.push(`attachments: ${describe(error)}`);
    }

    if (this.refunds) {
      try {
        result.refundsStarted = (await this.refunds.initiateDue()).started;
        result.refundsReconciled = (
          await this.refunds.reconcileUnresolved()
        ).checked;
      } catch (error) {
        result.errors.push(`refunds: ${describe(error)}`);
      }
    }

    if (this.charges) {
      try {
        result.chargesReconciled = (
          await this.charges.reconcileUnresolved()
        ).checked;
      } catch (error) {
        result.errors.push(`saved-card charges: ${describe(error)}`);
      }
    }

    if (this.savedCards) {
      try {
        result.cardRegistrationsFailed = (
          await this.savedCards.failAbandonedRegistrations(now)
        ).failed;
      } catch (error) {
        result.errors.push(`saved-card registrations: ${describe(error)}`);
      }
    }

    return result;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

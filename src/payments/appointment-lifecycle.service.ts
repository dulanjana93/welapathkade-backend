import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  Prisma,
  RefundObligation,
  ReliabilityIncidentType,
  User,
  UserRole,
  type Appointment,
} from '@prisma/client';
import { BookingGuardService } from '../availability/booking-guard.service';
import { assertConsultationTransition } from '../consultations/consultation.state';
import { PrismaService } from '../prisma/prisma.service';
import {
  toAppointmentView,
  toAstrologerAppointmentView,
} from './appointment.mapper';
import {
  assertSessionEvidenceCapability,
  type SessionEvidenceCapability,
} from '../session-evidence/capability';
import {
  assertAppointmentTransition,
  classifyNoShow,
  hasJoinGraceElapsed,
  isCancellationAllowedAt,
  isWithinJoinWindow,
  type AppointmentTransition,
} from './appointment.state';
import type { AttendanceInput, SessionEventInput } from './session-events';
import { PayHereRefundService } from './payhere-refund.service';

const appointmentInclude = {
  payments: { include: { attempts: true } },
} satisfies Prisma.AppointmentInclude;

type Tx = Prisma.TransactionClient;

/**
 * Appointment lifecycle beyond CONFIRMED.
 *
 * - Participant actions (cancel) are authorised against the appointment's own
 *   customer / astrologer.
 * - Session start/end and no-show classification require a live
 *   SessionEvidenceCapability (runtime WeakSet) plus plain event inputs.
 *   Type casts alone are rejected. No controller exposes these methods, and
 *   nothing trusts client-supplied duration or completion state.
 * - Production trusted callers: VideoSessionService (SESSION_START on first
 *   authorized credential issue) and SessionCompletionSweepService
 *   (SESSION_END after credential hard-end). Leaving Agora never completes.
 * - Every transition runs under the astrologer booking-guard lock and uses a
 *   status-guarded update, so concurrent attempts cannot contradict each other.
 * - Refund outcomes are recorded as an OBLIGATION inside the appointment lock.
 *   A PayHere refund, when one is due, is requested only after that lock
 *   commits. This lifecycle never credits wallets or referral ledgers.
 * - Financial allocation snapshots are created separately by
 *   FinancialSnapshotService after the 24h settlement hold (Phase A).
 *   Ledger CREDITS / wallet availability are posted by FinancialLedgerService
 *   (Phase B). This lifecycle never credits wallets or referral ledgers.
 */
@Injectable()
export class AppointmentLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingGuard: BookingGuardService,
    @Optional() private readonly refunds?: PayHereRefundService,
  ) {}

  /**
   * `now` is injectable for tests; production callers omit it and the check
   * uses the clock at the moment the appointment lock is held.
   */
  async cancelByCustomer(
    user: User,
    consultationId: string,
    reason?: string,
    now?: Date,
  ) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const appointment = await this.findLatestForConsultation(consultationId);
    if (!appointment || appointment.customerId !== user.id) {
      throw new NotFoundException('Appointment not found');
    }
    return this.cancel(appointment.id, 'CUSTOMER_CANCEL', reason, now);
  }

  async cancelByAstrologer(
    user: User,
    consultationId: string,
    reason?: string,
    now?: Date,
  ) {
    if (user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException('ASTROLOGER role required');
    }
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    const appointment = await this.findLatestForConsultation(consultationId);
    if (!profile || !appointment || appointment.astrologerId !== profile.id) {
      throw new NotFoundException('Appointment not found');
    }
    return this.cancel(appointment.id, 'ASTROLOGER_CANCEL', reason, now);
  }

  /**
   * CONFIRMED → IN_PROGRESS. Internal; requires a live session-evidence
   * capability (not a TypeScript cast) plus a provider event payload.
   */
  async recordSessionStart(
    capability: SessionEvidenceCapability,
    event: SessionEventInput,
  ) {
    assertSessionEvidenceCapability(capability);
    return this.locked(event.appointmentId, async (tx, current) => {
      if (
        current.status === AppointmentStatus.IN_PROGRESS &&
        current.sessionStartEventId === event.eventId
      ) {
        return this.reload(tx, current.id);
      }
      this.assertTransition(current.status, 'SESSION_START');
      if (!isWithinJoinWindow(current.startAt, event.occurredAt)) {
        throw new BadRequestException(
          'Session start is outside the permitted join window',
        );
      }
      await this.guardedUpdate(tx, current, AppointmentStatus.CONFIRMED, {
        status: AppointmentStatus.IN_PROGRESS,
        sessionStartedAt: event.occurredAt,
        sessionStartEventId: event.eventId,
      });
      return this.reload(tx, current.id);
    });
  }

  /**
   * IN_PROGRESS → COMPLETED. Internal; requires a live session-evidence
   * capability. Duration is derived server-side from the two timestamps.
   * Creates no financial, earnings or referral records.
   */
  async recordSessionEnd(
    capability: SessionEvidenceCapability,
    event: SessionEventInput,
  ) {
    assertSessionEvidenceCapability(capability);
    return this.locked(event.appointmentId, async (tx, current) => {
      if (current.status === AppointmentStatus.COMPLETED) {
        if (current.sessionEndEventId === event.eventId) {
          return this.reload(tx, current.id);
        }
        throw new ConflictException(
          'Appointment is already completed by a different event',
        );
      }
      this.assertTransition(current.status, 'SESSION_END');
      const startedAt = current.sessionStartedAt;
      if (!startedAt || event.occurredAt.getTime() < startedAt.getTime()) {
        throw new BadRequestException(
          'Session end cannot precede the verified session start',
        );
      }
      const actualDurationSeconds = Math.floor(
        (event.occurredAt.getTime() - startedAt.getTime()) / 1000,
      );
      await this.guardedUpdate(tx, current, AppointmentStatus.IN_PROGRESS, {
        status: AppointmentStatus.COMPLETED,
        sessionEndedAt: event.occurredAt,
        actualDurationSeconds,
        sessionEndEventId: event.eventId,
      });
      await this.closeConsultation(
        tx,
        current,
        'APPOINTMENT_COMPLETED',
        event.occurredAt,
      );
      return this.reload(tx, current.id);
    });
  }

  /**
   * CONFIRMED → NO_SHOW_*. Internal; requires a live session-evidence
   * capability, attendance facts, and a fully elapsed join grace period
   * (server clock). Never a client assertion and never a bare timer.
   * B3-a does not call this from the evidence recorder.
   */
  async recordNoShow(
    capability: SessionEvidenceCapability,
    report: AttendanceInput,
    now: Date = new Date(),
  ) {
    assertSessionEvidenceCapability(capability);
    const transition = classifyNoShow(report);
    if (!transition) {
      throw new BadRequestException(
        'Both participants joined; this is not a no-show',
      );
    }
    const owesRefund =
      transition === 'ASTROLOGER_NO_SHOW' || transition === 'BOTH_NO_SHOW';
    const view = await this.locked(report.appointmentId, async (tx, current) => {
      const target = noShowStatus(transition);
      if (current.status === target) {
        return this.reload(tx, current.id); // idempotent repeat
      }
      this.assertTransition(current.status, transition);
      if (!hasJoinGraceElapsed(current.startAt, now)) {
        throw new ConflictException(
          'No-show cannot be recorded before the join grace period ends',
        );
      }

      const customerOwesNothing = transition === 'CUSTOMER_NO_SHOW';
      await this.guardedUpdate(tx, current, AppointmentStatus.CONFIRMED, {
        status: target,
        noShowRecordedAt: now,
        ...(owesRefund ? refundObligationData(now) : {}),
        // Customer no-show: manual review before any settlement.
        manualReviewRequired: customerOwesNothing,
      });
      await this.closeConsultation(tx, current, 'APPOINTMENT_CLOSED');
      if (transition === 'ASTROLOGER_NO_SHOW') {
        await this.recordIncident(tx, current, ReliabilityIncidentType.NO_SHOW);
      }
      return this.reload(tx, current.id);
    });
    if (owesRefund) await this.startRefund(report.appointmentId);
    return view;
  }

  private async cancel(
    appointmentId: string,
    transition: 'CUSTOMER_CANCEL' | 'ASTROLOGER_CANCEL',
    reason?: string,
    nowOverride?: Date,
  ) {
    const target =
      transition === 'CUSTOMER_CANCEL'
        ? AppointmentStatus.CANCELLED_BY_CUSTOMER
        : AppointmentStatus.CANCELLED_BY_ASTROLOGER;
    // Only the customer's own response may include payment details.
    const customerView = transition === 'CUSTOMER_CANCEL';
    const view = await this.locked(appointmentId, async (tx, current) => {
      if (current.status === target) {
        return this.reload(tx, current.id, customerView); // idempotent repeat
      }
      this.assertTransition(current.status, transition);
      // Read the clock only now that the lock is held and the row is fresh.
      const now = nowOverride ?? new Date();
      // Checked before any write, so a rejected cancellation leaves no partial
      // appointment, consultation, refund-obligation or incident changes.
      if (!isCancellationAllowedAt(current.startAt, now)) {
        throw new ConflictException(
          'The appointment has reached its scheduled start time and can no longer be cancelled. ' +
            'The outcome is determined from session attendance.',
        );
      }
      // 100% refund obligation for a cancellation before the scheduled start
      // (customer and astrologer). Recorded as an obligation, not as a refund.
      await this.guardedUpdate(tx, current, AppointmentStatus.CONFIRMED, {
        status: target,
        cancelledAt: now,
        cancelReason: reason?.trim() || null,
        ...refundObligationData(now),
      });
      await this.closeConsultation(tx, current, 'APPOINTMENT_CLOSED');
      if (transition === 'ASTROLOGER_CANCEL') {
        await this.recordIncident(
          tx,
          current,
          ReliabilityIncidentType.CANCELLATION,
        );
      }
      return this.reload(tx, current.id, customerView);
    });
    await this.startRefund(appointmentId);
    return view;
  }

  private async startRefund(appointmentId: string) {
    if (!this.refunds) return;
    try {
      await this.refunds.requestForAppointment(appointmentId);
    } catch {
      // The obligation is already committed. A later sweep can start the refund.
    }
  }

  private async locked<T>(
    appointmentId: string,
    work: (tx: Tx, current: Appointment) => Promise<T>,
  ): Promise<T> {
    const head = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { astrologerId: true },
    });
    if (!head) {
      throw new NotFoundException('Appointment not found');
    }
    try {
      return await this.bookingGuard.withAstrologerLock(
        head.astrologerId,
        async (tx) => {
          // Re-read under the lock: the decision must use fresh state.
          const current = await tx.appointment.findUnique({
            where: { id: appointmentId },
          });
          if (!current) {
            throw new NotFoundException('Appointment not found');
          }
          return work(tx, current);
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // A provider event id may apply to exactly one appointment transition.
        throw new ConflictException('Session event was already applied');
      }
      throw error;
    }
  }

  private async guardedUpdate(
    tx: Tx,
    current: Appointment,
    from: AppointmentStatus,
    data: Prisma.AppointmentUpdateManyMutationInput,
  ) {
    const result = await tx.appointment.updateMany({
      where: { id: current.id, status: from },
      data,
    });
    if (result.count === 0) {
      throw new ConflictException('Appointment state changed concurrently');
    }
  }

  /**
   * Closes the linked consultation in the SAME transaction as the appointment
   * transition. Only an ACCEPTED consultation may be closed; any other state is
   * a conflict and aborts (rolls back) the whole transition rather than
   * overwriting it. completedAt is set only for a legitimate completion.
   */
  private async closeConsultation(
    tx: Tx,
    appointment: Appointment,
    transition: 'APPOINTMENT_CLOSED' | 'APPOINTMENT_COMPLETED',
    completedAt?: Date,
  ) {
    const to = assertConsultationTransition(
      ConsultationStatus.ACCEPTED,
      transition,
    );
    const result = await tx.consultation.updateMany({
      where: {
        id: appointment.consultationId,
        status: ConsultationStatus.ACCEPTED,
      },
      data: { status: to, ...(completedAt ? { completedAt } : {}) },
    });
    if (result.count === 0) {
      throw new ConflictException(
        'Consultation is not in the expected ACCEPTED state; appointment transition was not applied',
      );
    }
  }

  private async recordIncident(
    tx: Tx,
    current: Appointment,
    type: ReliabilityIncidentType,
  ) {
    await tx.astrologerReliabilityIncident.upsert({
      where: { appointmentId_type: { appointmentId: current.id, type } },
      create: {
        appointmentId: current.id,
        astrologerId: current.astrologerId,
        type,
      },
      update: {},
    });
  }

  private assertTransition(
    status: AppointmentStatus,
    transition: AppointmentTransition,
  ) {
    try {
      assertAppointmentTransition(status, transition);
    } catch {
      throw new ConflictException(
        `Cannot ${transition} an appointment in status ${status}`,
      );
    }
  }

  /**
   * Only the customer's own cancellation response carries payment details.
   * Astrologer-initiated and internal results never include them.
   */
  private async reload(tx: Tx, id: string, includePayment = false) {
    const row = await tx.appointment.findUniqueOrThrow({
      where: { id },
      include: appointmentInclude,
    });
    return includePayment
      ? toAppointmentView(row)
      : toAstrologerAppointmentView(row);
  }

  private findLatestForConsultation(consultationId: string) {
    return this.prisma.appointment.findFirst({
      where: { consultationId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

function refundObligationData(now: Date) {
  return {
    refundObligation: RefundObligation.FULL_REFUND_DUE,
    refundObligationRecordedAt: now,
  };
}

function noShowStatus(transition: AppointmentTransition): AppointmentStatus {
  return assertAppointmentTransition(AppointmentStatus.CONFIRMED, transition);
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SessionAttendanceEvidence } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  attachMappedAppointment,
  isSameAttendanceEventIdentity,
  validateAttendanceEventDraft,
  type AttendanceEventDraft,
  type ValidatedAttendanceEvent,
} from './attendance-event.contract';
import {
  assertSessionEvidenceCapability,
  type SessionEvidenceCapability,
} from './capability';
import { RoomAppointmentMappingResolver } from './room-mapping';

export type AttendanceEvidenceRecordResult = {
  status: 'CREATED' | 'DUPLICATE';
  evidence: SessionAttendanceEvidence;
};

/**
 * Persists verified join/leave facts for investigation.
 *
 * - Requires a live runtime capability (not a TypeScript cast).
 * - Resolves appointmentId only via RoomAppointmentMappingResolver.
 * - Never updates Appointment status, refunds, manual-review flags, or
 *   reliability incidents; never calls lifecycle session-start / end / no-show.
 */
@Injectable()
export class SessionEvidenceService {
  private readonly logger = new Logger(SessionEvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roomMapping: RoomAppointmentMappingResolver,
  ) {}

  async recordAttendanceEvent(
    capability: SessionEvidenceCapability,
    draft: AttendanceEventDraft,
    now: Date = new Date(),
  ): Promise<AttendanceEvidenceRecordResult> {
    assertSessionEvidenceCapability(capability);

    if (draft && Object.prototype.hasOwnProperty.call(draft, 'appointmentId')) {
      throw new BadRequestException(
        'appointmentId must not be supplied by the caller; it is resolved from the provider room mapping',
      );
    }

    const validatedDraft = validateAttendanceEventDraft(draft);
    const appointmentId = await this.roomMapping.resolveAppointmentId(
      validatedDraft.provider,
      validatedDraft.providerRoomId,
    );
    const event = attachMappedAppointment(validatedDraft, appointmentId);

    const appointment = await this.prisma.appointment.findUnique({
      where: { id: event.appointmentId },
      select: { id: true },
    });
    if (!appointment) {
      throw new NotFoundException(
        'Mapped appointment not found for attendance evidence; refusing to attach by guesswork',
      );
    }

    return this.insertIdempotent(event, now);
  }

  async listForAppointment(
    appointmentId: string,
  ): Promise<SessionAttendanceEvidence[]> {
    return this.prisma.sessionAttendanceEvidence.findMany({
      where: { appointmentId },
      orderBy: [{ providerOccurredAt: 'desc' }, { receivedAt: 'desc' }],
    });
  }

  private async insertIdempotent(
    event: ValidatedAttendanceEvent,
    receivedAt: Date,
  ): Promise<AttendanceEvidenceRecordResult> {
    try {
      const evidence = await this.prisma.sessionAttendanceEvidence.create({
        data: {
          provider: event.provider,
          providerEventId: event.providerEventId,
          providerRoomId: event.providerRoomId,
          appointmentId: event.appointmentId,
          participantRole: event.participantRole,
          eventKind: event.eventKind,
          providerOccurredAt: event.providerOccurredAt,
          receivedAt,
          sourceMeta: event.sourceMeta ?? Prisma.JsonNull,
        },
      });
      return { status: 'CREATED', evidence };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.resolveDuplicate(event);
      }
      throw error;
    }
  }

  private async resolveDuplicate(
    event: ValidatedAttendanceEvent,
  ): Promise<AttendanceEvidenceRecordResult> {
    const existing = await this.prisma.sessionAttendanceEvidence.findUnique({
      where: {
        provider_providerEventId: {
          provider: event.provider,
          providerEventId: event.providerEventId,
        },
      },
    });
    if (!existing) {
      throw new ConflictException(
        'Session attendance event id conflict could not be resolved',
      );
    }

    if (isSameAttendanceEventIdentity(existing, event)) {
      return { status: 'DUPLICATE', evidence: existing };
    }

    this.logger.warn(
      `Conflicting attendance event replay provider=${event.provider} ` +
        `eventId=${event.providerEventId} existingKind=${existing.eventKind} ` +
        `incomingKind=${event.eventKind}`,
    );
    throw new ConflictException(
      'Provider event id was reused with conflicting attendance content',
    );
  }
}

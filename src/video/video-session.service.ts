import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, UserRole, type User } from '@prisma/client';
import { AppointmentLifecycleService } from '../payments/appointment-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { mintInternalSessionLifecycleCapability } from '../session-evidence/capability';
import { videoJoinSessionStartEventId } from '../session-evidence/internal-lifecycle-events';
import {
  AgoraTokenService,
  type AgoraRtcCredentials,
} from './agora-token.service';
import type { VideoParticipantRole } from './agora-identity';
import {
  computeVideoTokenTtlSeconds,
  isVideoJoinableStatus,
  isWithinVideoCredentialWindow,
} from './video-session.eligibility';

@Injectable()
export class VideoSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agoraTokens: AgoraTokenService,
    private readonly lifecycle: AppointmentLifecycleService,
  ) {}

  /**
   * Issue Agora RTC join credentials for an eligible appointment participant.
   *
   * The first authorized credential issuance inside the join window records
   * SESSION_START (CONFIRMED → IN_PROGRESS). Repeated token requests and the
   * second participant joining reuse the same deterministic event id and do
   * not reset `sessionStartedAt`. Leaving Agora does not complete the session.
   */
  async issueCredentialsForConsultation(
    user: User,
    consultationId: string,
    now: Date = new Date(),
  ): Promise<AgoraRtcCredentials> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { consultationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        startAt: true,
        endAt: true,
        customerId: true,
        astrologerId: true,
      },
    });
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    const participantRole = await this.resolveParticipantRole(
      user,
      appointment,
    );

    if (!isVideoJoinableStatus(appointment.status)) {
      throw new ConflictException(
        `Video session is not available for appointment status ${appointment.status}`,
      );
    }

    if (
      !isWithinVideoCredentialWindow({
        status: appointment.status,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        now,
      })
    ) {
      throw new ConflictException(
        appointment.status === AppointmentStatus.CONFIRMED
          ? 'Video session credentials are only available inside the join window'
          : 'Video session credentials are no longer available for this appointment',
      );
    }

    if (appointment.status === AppointmentStatus.CONFIRMED) {
      await this.lifecycle.recordSessionStart(
        mintInternalSessionLifecycleCapability(),
        {
          eventId: videoJoinSessionStartEventId(appointment.id),
          appointmentId: appointment.id,
          occurredAt: now,
        },
      );
    }

    const ttlSeconds = computeVideoTokenTtlSeconds({
      endAt: appointment.endAt,
      now,
    });

    return this.agoraTokens.issueRtcCredentials({
      appointmentId: appointment.id,
      participantRole,
      ttlSeconds,
      now,
    });
  }

  private async resolveParticipantRole(
    user: User,
    appointment: {
      customerId: string;
      astrologerId: string;
    },
  ): Promise<VideoParticipantRole> {
    if (user.role === UserRole.PUBLIC) {
      if (appointment.customerId !== user.id) {
        throw new NotFoundException('Appointment not found');
      }
      return 'CUSTOMER';
    }

    if (user.role === UserRole.ASTROLOGER) {
      const profile = await this.prisma.astrologerProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!profile || profile.id !== appointment.astrologerId) {
        throw new NotFoundException('Appointment not found');
      }
      return 'ASTROLOGER';
    }

    throw new ForbiddenException(
      'Only the customer or assigned astrologer may join the video session',
    );
  }
}

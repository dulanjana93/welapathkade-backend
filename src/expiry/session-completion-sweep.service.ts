import { Injectable, Logger } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { AppointmentLifecycleService } from '../payments/appointment-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { mintInternalSessionLifecycleCapability } from '../session-evidence/capability';
import { sessionHardEndEventId } from '../session-evidence/internal-lifecycle-events';
import { VIDEO_SESSION_END_BUFFER_MINUTES } from '../video/video-session.eligibility';

export type SessionCompletionSweepResult = {
  /** IN_PROGRESS appointments completed via SESSION_END. */
  completed: number;
  errors: string[];
};

/**
 * Completes IN_PROGRESS appointments whose credential hard-end has passed.
 *
 * Policy (documented in docs/state-machines.md §3.3.3):
 * - Only appointments that already have a verified SESSION_START
 *   (`IN_PROGRESS` + `sessionStartedAt`) are eligible.
 * - Scheduled end alone never completes a never-started (CONFIRMED) appointment.
 * - Leaving Agora does not call this path; the sweep is the trusted trigger
 *   for SESSION_END until a media-provider adapter exists.
 * - Duration is derived inside AppointmentLifecycleService from server
 *   timestamps; clients cannot supply end time or duration.
 */
@Injectable()
export class SessionCompletionSweepService {
  private readonly logger = new Logger(SessionCompletionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: AppointmentLifecycleService,
  ) {}

  async completeDueSessions(
    now: Date = new Date(),
  ): Promise<SessionCompletionSweepResult> {
    const result: SessionCompletionSweepResult = { completed: 0, errors: [] };
    const hardEndPassedBefore = new Date(
      now.getTime() - VIDEO_SESSION_END_BUFFER_MINUTES * 60_000,
    );

    let due: Array<{ id: string; sessionStartedAt: Date | null }>;
    try {
      due = await this.prisma.appointment.findMany({
        where: {
          status: AppointmentStatus.IN_PROGRESS,
          sessionStartedAt: { not: null },
          endAt: { lte: hardEndPassedBefore },
        },
        select: { id: true, sessionStartedAt: true },
        take: 100,
        orderBy: { endAt: 'asc' },
      });
    } catch (error) {
      result.errors.push(`query: ${describe(error)}`);
      return result;
    }

    const capability = mintInternalSessionLifecycleCapability();
    for (const row of due) {
      try {
        await this.lifecycle.recordSessionEnd(capability, {
          eventId: sessionHardEndEventId(row.id),
          appointmentId: row.id,
          occurredAt: now,
        });
        result.completed += 1;
      } catch (error) {
        const message = describe(error);
        this.logger.warn(
          `Session hard-end completion failed for ${row.id}: ${message}`,
        );
        result.errors.push(`${row.id}: ${message}`);
      }
    }

    return result;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

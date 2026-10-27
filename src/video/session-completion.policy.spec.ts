import { AppointmentStatus, ConsultationStatus } from '@prisma/client';
import { deriveConsultationActionability } from '../consultations/consultation.actionability';
import {
  isVideoJoinableStatus,
  isWithinVideoCredentialWindow,
  VIDEO_SESSION_END_BUFFER_MINUTES,
} from './video-session.eligibility';

/**
 * Policy checks for Phase 1 session completion without spinning the Nest app.
 * Lifecycle transition mechanics are covered by appointment-lifecycle specs;
 * credential issuance wiring is covered by video-session.service specs.
 */
describe('session completion policy', () => {
  const startAt = new Date('2026-10-10T12:00:00.000Z');
  const endAt = new Date('2026-10-10T12:15:00.000Z');

  function actionability(
    status: AppointmentStatus,
    now: Date,
    viewer: 'CUSTOMER' | 'ASTROLOGER' = 'CUSTOMER',
  ) {
    return deriveConsultationActionability({
      viewer,
      consultationStatus:
        status === AppointmentStatus.COMPLETED
          ? ConsultationStatus.COMPLETED
          : ConsultationStatus.ACCEPTED,
      hasPendingProposal: false,
      hasAcceptedProposal: true,
      appointmentStatus: status,
      appointmentStartAt: startAt,
      appointmentEndAt: endAt,
      now,
    });
  }

  it('COMPLETED rejects join for both roles and is closed', () => {
    const now = new Date('2026-10-10T12:20:00.000Z');
    for (const viewer of ['CUSTOMER', 'ASTROLOGER'] as const) {
      const a = actionability(AppointmentStatus.COMPLETED, now, viewer);
      expect(a.canJoinVideoSession).toBe(false);
      expect(a.isClosed).toBe(true);
      expect(a.stage).toBe('COMPLETED');
      expect(a.canCheckout).toBe(false);
    }
    expect(isVideoJoinableStatus(AppointmentStatus.COMPLETED)).toBe(false);
  });

  it('IN_PROGRESS remains joinable until hard end, then not', () => {
    const beforeHardEnd = new Date(
      endAt.getTime() + (VIDEO_SESSION_END_BUFFER_MINUTES - 1) * 60_000,
    );
    const afterHardEnd = new Date(
      endAt.getTime() + VIDEO_SESSION_END_BUFFER_MINUTES * 60_000 + 1,
    );
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.IN_PROGRESS,
        startAt,
        endAt,
        now: beforeHardEnd,
      }),
    ).toBe(true);
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.IN_PROGRESS,
        startAt,
        endAt,
        now: afterHardEnd,
      }),
    ).toBe(false);
    expect(
      actionability(AppointmentStatus.IN_PROGRESS, afterHardEnd)
        .canJoinVideoSession,
    ).toBe(false);
  });

  it('scheduled end without a session start does not look completed', () => {
    const afterEnd = new Date('2026-10-10T12:20:00.000Z');
    const a = actionability(AppointmentStatus.CONFIRMED, afterEnd);
    expect(a.stage).toBe('CONFIRMED');
    expect(a.isClosed).toBe(false);
    expect(a.canJoinVideoSession).toBe(false);
  });

  it('no-show stages stay closed without join', () => {
    for (const status of [
      AppointmentStatus.NO_SHOW_CUSTOMER,
      AppointmentStatus.NO_SHOW_ASTROLOGER,
      AppointmentStatus.NO_SHOW_BOTH,
    ]) {
      const a = actionability(status, new Date('2026-10-10T12:30:00.000Z'));
      expect(a.canJoinVideoSession).toBe(false);
      expect(a.isClosed).toBe(true);
      expect(a.stage).not.toBe('COMPLETED');
    }
  });
});

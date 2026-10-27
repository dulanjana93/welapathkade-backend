import { AppointmentStatus } from '@prisma/client';
import {
  isWithinJoinWindow,
  JOIN_GRACE_AFTER_START_MINUTES,
  JOIN_WINDOW_BEFORE_START_MINUTES,
} from '../payments/appointment.state';

/** Extra minutes past scheduled endAt for late wrap-up / token renewal. */
export const VIDEO_SESSION_END_BUFFER_MINUTES = 5;

/** Absolute upper bound on a single issued token lifetime. */
export const VIDEO_TOKEN_MAX_TTL_SECONDS =
  (JOIN_WINDOW_BEFORE_START_MINUTES +
    JOIN_GRACE_AFTER_START_MINUTES +
    120 +
    VIDEO_SESSION_END_BUFFER_MINUTES) *
  60;

export const VIDEO_TOKEN_MIN_TTL_SECONDS = 60;

const JOINABLE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.IN_PROGRESS,
];

export function isVideoJoinableStatus(status: AppointmentStatus): boolean {
  return JOINABLE_STATUSES.includes(status);
}

/**
 * Time window for obtaining / renewing video credentials.
 *
 * - CONFIRMED: only inside the existing join window [start-10m, start+10m].
 * - IN_PROGRESS: from join-window open through scheduled endAt + buffer
 *   (session may already be underway past the grace period).
 *
 * Issuing credentials never transitions appointment state.
 */
export function isWithinVideoCredentialWindow(params: {
  status: AppointmentStatus;
  startAt: Date;
  endAt: Date;
  now: Date;
}): boolean {
  const { status, startAt, endAt, now } = params;
  if (status === AppointmentStatus.CONFIRMED) {
    return isWithinJoinWindow(startAt, now);
  }
  if (status === AppointmentStatus.IN_PROGRESS) {
    const openFrom =
      startAt.getTime() - JOIN_WINDOW_BEFORE_START_MINUTES * 60_000;
    const hardEnd = endAt.getTime() + VIDEO_SESSION_END_BUFFER_MINUTES * 60_000;
    const t = now.getTime();
    return t >= openFrom && t <= hardEnd;
  }
  return false;
}

/** Privilege/token TTL in seconds from `now` until hard end, clamped. */
export function computeVideoTokenTtlSeconds(params: {
  endAt: Date;
  now: Date;
}): number {
  const hardEnd =
    params.endAt.getTime() + VIDEO_SESSION_END_BUFFER_MINUTES * 60_000;
  const remainingMs = hardEnd - params.now.getTime();
  const rawSeconds = Math.ceil(remainingMs / 1000);
  return Math.min(
    VIDEO_TOKEN_MAX_TTL_SECONDS,
    Math.max(VIDEO_TOKEN_MIN_TTL_SECONDS, rawSeconds),
  );
}

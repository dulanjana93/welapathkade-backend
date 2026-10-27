import { AppointmentStatus } from '@prisma/client';
import {
  computeVideoTokenTtlSeconds,
  isVideoJoinableStatus,
  isWithinVideoCredentialWindow,
  VIDEO_TOKEN_MIN_TTL_SECONDS,
} from './video-session.eligibility';

describe('video-session eligibility', () => {
  const startAt = new Date('2026-10-10T12:00:00.000Z');
  const endAt = new Date('2026-10-10T12:30:00.000Z');

  it('allows only CONFIRMED and IN_PROGRESS statuses', () => {
    expect(isVideoJoinableStatus(AppointmentStatus.CONFIRMED)).toBe(true);
    expect(isVideoJoinableStatus(AppointmentStatus.IN_PROGRESS)).toBe(true);
    expect(isVideoJoinableStatus(AppointmentStatus.PAYMENT_PENDING)).toBe(
      false,
    );
    expect(isVideoJoinableStatus(AppointmentStatus.COMPLETED)).toBe(false);
    expect(isVideoJoinableStatus(AppointmentStatus.CANCELLED_BY_CUSTOMER)).toBe(
      false,
    );
    expect(isVideoJoinableStatus(AppointmentStatus.NO_SHOW_BOTH)).toBe(false);
  });

  it('CONFIRMED: only inside the join window', () => {
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.CONFIRMED,
        startAt,
        endAt,
        now: new Date('2026-10-10T11:49:00.000Z'),
      }),
    ).toBe(false);
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.CONFIRMED,
        startAt,
        endAt,
        now: new Date('2026-10-10T11:50:00.000Z'),
      }),
    ).toBe(true);
    // Short-notice test appointments (~5 min ahead) are already inside ±10m.
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.CONFIRMED,
        startAt,
        endAt,
        now: new Date('2026-10-10T11:55:00.000Z'),
      }),
    ).toBe(true);
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.CONFIRMED,
        startAt,
        endAt,
        now: new Date('2026-10-10T12:10:00.000Z'),
      }),
    ).toBe(true);
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.CONFIRMED,
        startAt,
        endAt,
        now: new Date('2026-10-10T12:10:01.000Z'),
      }),
    ).toBe(false);
  });

  it('IN_PROGRESS: allows through scheduled end + buffer', () => {
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.IN_PROGRESS,
        startAt,
        endAt,
        now: new Date('2026-10-10T12:20:00.000Z'),
      }),
    ).toBe(true);
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.IN_PROGRESS,
        startAt,
        endAt,
        now: new Date('2026-10-10T12:35:00.000Z'),
      }),
    ).toBe(true);
    expect(
      isWithinVideoCredentialWindow({
        status: AppointmentStatus.IN_PROGRESS,
        startAt,
        endAt,
        now: new Date('2026-10-10T12:35:01.000Z'),
      }),
    ).toBe(false);
  });

  it('clamps token TTL to a practical remaining window', () => {
    const now = new Date('2026-10-10T12:25:00.000Z');
    const ttl = computeVideoTokenTtlSeconds({ endAt, now });
    // 5 min remaining + 5 min buffer = 600s
    expect(ttl).toBe(600);
    expect(
      computeVideoTokenTtlSeconds({
        endAt,
        now: new Date('2026-10-10T12:40:00.000Z'),
      }),
    ).toBe(VIDEO_TOKEN_MIN_TTL_SECONDS);
  });
});

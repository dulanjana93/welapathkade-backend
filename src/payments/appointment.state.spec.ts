import { AppointmentStatus } from '@prisma/client';
import {
  APPOINTMENT_TRANSITIONS,
  assertAppointmentTransition,
  classifyNoShow,
  hasJoinGraceElapsed,
  isAppointmentHoldActive,
  isCancellationAllowedAt,
  isWithinJoinWindow,
  type AppointmentTransition,
} from './appointment.state';

describe('appointment.state', () => {
  it('allows PAYMENT_PENDING → CONFIRMED', () => {
    expect(
      assertAppointmentTransition(
        AppointmentStatus.PAYMENT_PENDING,
        'PAYMENT_SUCCESS',
      ),
    ).toBe(AppointmentStatus.CONFIRMED);
  });

  it('allows PAYMENT_PENDING → PAYMENT_EXPIRED', () => {
    expect(
      assertAppointmentTransition(
        AppointmentStatus.PAYMENT_PENDING,
        'PAYMENT_TIMEOUT',
      ),
    ).toBe(AppointmentStatus.PAYMENT_EXPIRED);
  });

  it('rejects confirm from CONFIRMED', () => {
    expect(() =>
      assertAppointmentTransition(
        AppointmentStatus.CONFIRMED,
        'PAYMENT_SUCCESS',
      ),
    ).toThrow(/Invalid appointment transition/);
  });

  it('treats unexpired PAYMENT_PENDING as an active hold', () => {
    const future = new Date(Date.now() + 60_000);
    expect(
      isAppointmentHoldActive(AppointmentStatus.PAYMENT_PENDING, future),
    ).toBe(true);
    expect(
      isAppointmentHoldActive(
        AppointmentStatus.PAYMENT_PENDING,
        new Date(Date.now() - 1000),
      ),
    ).toBe(false);
    expect(isAppointmentHoldActive(AppointmentStatus.CONFIRMED, future)).toBe(
      false,
    );
  });

  describe('transition table', () => {
    const expected: Array<
      [AppointmentTransition, AppointmentStatus, AppointmentStatus]
    > = [
      ['PAYMENT_SUCCESS', 'PAYMENT_PENDING', 'CONFIRMED'],
      ['PAYMENT_TIMEOUT', 'PAYMENT_PENDING', 'PAYMENT_EXPIRED'],
      ['SESSION_START', 'CONFIRMED', 'IN_PROGRESS'],
      ['SESSION_END', 'IN_PROGRESS', 'COMPLETED'],
      ['CUSTOMER_CANCEL', 'CONFIRMED', 'CANCELLED_BY_CUSTOMER'],
      ['ASTROLOGER_CANCEL', 'CONFIRMED', 'CANCELLED_BY_ASTROLOGER'],
      ['CUSTOMER_NO_SHOW', 'CONFIRMED', 'NO_SHOW_CUSTOMER'],
      ['ASTROLOGER_NO_SHOW', 'CONFIRMED', 'NO_SHOW_ASTROLOGER'],
      ['BOTH_NO_SHOW', 'CONFIRMED', 'NO_SHOW_BOTH'],
    ];

    it.each(expected)('allows %s: %s → %s', (transition, from, to) => {
      expect(assertAppointmentTransition(from, transition)).toBe(to);
    });

    it('covers every defined transition', () => {
      expect(Object.keys(APPOINTMENT_TRANSITIONS).sort()).toEqual(
        expected.map(([t]) => t).sort(),
      );
    });

    it('rejects every transition from every non-source status', () => {
      for (const [transition, from] of expected) {
        for (const status of Object.values(AppointmentStatus)) {
          if (status === from) continue;
          expect(() => assertAppointmentTransition(status, transition)).toThrow(
            /Invalid appointment transition/,
          );
        }
      }
    });

    it('treats terminal statuses as terminal (no outgoing transition)', () => {
      const terminal: AppointmentStatus[] = [
        'PAYMENT_EXPIRED',
        'COMPLETED',
        'CANCELLED_BY_CUSTOMER',
        'CANCELLED_BY_ASTROLOGER',
        'NO_SHOW_CUSTOMER',
        'NO_SHOW_ASTROLOGER',
        'NO_SHOW_BOTH',
        'CANCELLED',
      ];
      for (const status of terminal) {
        for (const transition of Object.keys(
          APPOINTMENT_TRANSITIONS,
        ) as AppointmentTransition[]) {
          expect(() =>
            assertAppointmentTransition(status, transition),
          ).toThrow();
        }
      }
    });

    it('names an initiator for every transition; none is a bare client claim', () => {
      expect(APPOINTMENT_TRANSITIONS.SESSION_START.initiator).toBe(
        'VERIFIED_SESSION_EVENT',
      );
      expect(APPOINTMENT_TRANSITIONS.SESSION_END.initiator).toBe(
        'VERIFIED_SESSION_EVENT',
      );
      expect(APPOINTMENT_TRANSITIONS.BOTH_NO_SHOW.initiator).toBe(
        'VERIFIED_ATTENDANCE_REPORT',
      );
    });
  });

  describe('no-show classification', () => {
    it('classifies from verified attendance', () => {
      expect(
        classifyNoShow({ customerJoined: false, astrologerJoined: true }),
      ).toBe('CUSTOMER_NO_SHOW');
      expect(
        classifyNoShow({ customerJoined: true, astrologerJoined: false }),
      ).toBe('ASTROLOGER_NO_SHOW');
      expect(
        classifyNoShow({ customerJoined: false, astrologerJoined: false }),
      ).toBe('BOTH_NO_SHOW');
      expect(
        classifyNoShow({ customerJoined: true, astrologerJoined: true }),
      ).toBeNull();
    });
  });

  describe('join window (10 min before, 10 min after scheduled start)', () => {
    const start = new Date('2026-10-01T04:30:00.000Z');
    const at = (minutes: number) =>
      new Date(start.getTime() + minutes * 60_000);

    it('accepts the inclusive window edges and rejects outside', () => {
      expect(isWithinJoinWindow(start, at(-10))).toBe(true);
      expect(isWithinJoinWindow(start, at(10))).toBe(true);
      expect(isWithinJoinWindow(start, at(-10.01))).toBe(false);
      expect(isWithinJoinWindow(start, at(10.01))).toBe(false);
    });

    it('grace has elapsed only strictly after start + 10 min', () => {
      expect(hasJoinGraceElapsed(start, at(10))).toBe(false);
      expect(hasJoinGraceElapsed(start, at(10.01))).toBe(true);
    });
  });

  describe('cancellation time boundary', () => {
    const start = new Date('2026-10-01T04:30:00.000Z');
    const at = (ms: number) => new Date(start.getTime() + ms);
    const MIN = 60_000;

    it.each([
      ['a day before', -24 * 60 * MIN, true],
      ['before the join window opens', -10 * MIN - 1, true],
      ['exactly when the join window opens', -10 * MIN, true],
      ['inside the join window', -5 * MIN, true],
      ['1 ms before the scheduled start', -1, true],
      ['exactly at the scheduled start', 0, false],
      ['1 ms after the scheduled start', 1, false],
      ['inside the late-grace period', 5 * MIN, false],
      ['exactly at the end of the grace period', 10 * MIN, false],
      ['1 ms after the grace period', 10 * MIN + 1, false],
      ['a day after', 24 * 60 * MIN, false],
    ])('%s', (_name, offsetMs, allowed) => {
      expect(isCancellationAllowedAt(start, at(offsetMs))).toBe(allowed);
    });
  });
});

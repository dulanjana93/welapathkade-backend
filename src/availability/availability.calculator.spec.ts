import {
  AvailabilityExceptionType,
  DayOfWeek,
  type AvailabilityException,
  type WeeklyAvailability,
} from '@prisma/client';
import { AvailabilityCalculator } from './availability.calculator';
import { localColomboToUtc } from './availability.time';

function weekly(
  dayOfWeek: DayOfWeek,
  startTime: string,
  endTime: string,
): WeeklyAvailability {
  return {
    id: `${dayOfWeek}-${startTime}`,
    astrologerId: 'a1',
    dayOfWeek,
    startTime,
    endTime,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function exception(
  partial: Partial<AvailabilityException> & {
    date: Date;
    type: AvailabilityExceptionType;
  },
): AvailabilityException {
  return {
    id: partial.id ?? 'e1',
    astrologerId: 'a1',
    date: partial.date,
    type: partial.type,
    startTime: partial.startTime ?? null,
    endTime: partial.endTime ?? null,
    reason: partial.reason ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('AvailabilityCalculator', () => {
  const calculator = new AvailabilityCalculator();

  it('respects weekly schedule for local windows', () => {
    const windows = calculator.resolveLocalWindowsForDate({
      dateIso: '2026-09-21', // Monday
      weekly: [
        weekly(DayOfWeek.MONDAY, '09:00', '12:00'),
        weekly(DayOfWeek.MONDAY, '14:00', '18:00'),
        weekly(DayOfWeek.TUESDAY, '10:00', '17:00'),
      ],
      exceptions: [],
    });
    expect(windows).toEqual([
      { startTime: '09:00', endTime: '12:00' },
      { startTime: '14:00', endTime: '18:00' },
    ]);
  });

  it('UNAVAILABLE exception clears the day', () => {
    const windows = calculator.resolveLocalWindowsForDate({
      dateIso: '2026-09-25', // Friday
      weekly: [weekly(DayOfWeek.FRIDAY, '09:00', '17:00')],
      exceptions: [
        exception({
          date: new Date(Date.UTC(2026, 8, 25)),
          type: AvailabilityExceptionType.UNAVAILABLE,
        }),
      ],
    });
    expect(windows).toEqual([]);
  });

  it('AVAILABLE_OVERRIDE replaces weekly windows for that date', () => {
    const windows = calculator.resolveLocalWindowsForDate({
      dateIso: '2026-09-26', // Saturday — normally unavailable in this fixture
      weekly: [weekly(DayOfWeek.FRIDAY, '09:00', '17:00')],
      exceptions: [
        exception({
          date: new Date(Date.UTC(2026, 8, 26)),
          type: AvailabilityExceptionType.AVAILABLE_OVERRIDE,
          startTime: '14:00',
          endTime: '18:00',
        }),
      ],
    });
    expect(windows).toEqual([{ startTime: '14:00', endTime: '18:00' }]);
  });

  it('converts Asia/Colombo local times to UTC correctly', () => {
    // Sri Lanka is UTC+5:30 year-round (no DST).
    const utc = localColomboToUtc('2026-09-21', '09:00');
    expect(utc.toISOString()).toBe('2026-09-21T03:30:00.000Z');
    const evening = localColomboToUtc('2026-09-21', '23:30');
    expect(evening.toISOString()).toBe('2026-09-21T18:00:00.000Z');
  });

  it('handles midnight-adjacent local windows without spilling into next day', () => {
    const windows = calculator.buildUtcWindows({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      weekly: [weekly(DayOfWeek.MONDAY, '22:00', '23:30')],
      exceptions: [],
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].startAt.toISOString()).toBe('2026-09-21T16:30:00.000Z');
    expect(windows[0].endAt.toISOString()).toBe('2026-09-21T18:00:00.000Z');
  });

  it('accepts a public window that starts exactly 10 minutes ahead', () => {
    // Monday 09:00–12:00 Colombo = 03:30–06:30 UTC
    // now = 03:20 UTC → lead cutoff 03:30 UTC → start equals cutoff (accepted)
    const windows = calculator.buildUtcWindows({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      weekly: [weekly(DayOfWeek.MONDAY, '09:00', '12:00')],
      exceptions: [],
      now: new Date('2026-09-21T03:20:00.000Z'),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].startAt.toISOString()).toBe('2026-09-21T03:30:00.000Z');
    expect(windows[0].endAt.toISOString()).toBe('2026-09-21T06:30:00.000Z');
  });

  it('clamps a public window that would start 9 minutes ahead to the 10-minute lead', () => {
    // Window start 03:30; now 03:21 → lead cutoff 03:31 → clamp to 03:31
    const windows = calculator.buildUtcWindows({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      weekly: [weekly(DayOfWeek.MONDAY, '09:00', '12:00')],
      exceptions: [],
      now: new Date('2026-09-21T03:21:00.000Z'),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].startAt.toISOString()).toBe('2026-09-21T03:31:00.000Z');
    expect(windows[0].endAt.toISOString()).toBe('2026-09-21T06:30:00.000Z');
  });

  it('does not clamp a public window 60 minutes ahead of now', () => {
    // now = 02:30 UTC → lead cutoff 02:40; window starts 03:30 (unchanged)
    const windows = calculator.buildUtcWindows({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      weekly: [weekly(DayOfWeek.MONDAY, '09:00', '12:00')],
      exceptions: [],
      now: new Date('2026-09-21T02:30:00.000Z'),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].startAt.toISOString()).toBe('2026-09-21T03:30:00.000Z');
  });

  it('enumerates a public slot that starts exactly at the 10-minute lead cutoff', () => {
    const now = new Date('2026-09-21T03:20:00.000Z');
    const slots = calculator.enumerateSlots({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      durationMinutes: 15,
      weekly: [weekly(DayOfWeek.MONDAY, '09:00', '12:00')],
      exceptions: [],
      now,
      intervalMinutes: 15,
    });
    expect(slots[0]?.startAt.toISOString()).toBe('2026-09-21T03:30:00.000Z');
    expect(
      slots.every(
        (s) => s.startAt.getTime() >= now.getTime() + 10 * 60_000,
      ),
    ).toBe(true);
  });

  it('does not enumerate public slots that would start before the 10-minute lead', () => {
    const now = new Date('2026-09-21T03:21:00.000Z');
    const slots = calculator.enumerateSlots({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      durationMinutes: 15,
      weekly: [weekly(DayOfWeek.MONDAY, '09:00', '12:00')],
      exceptions: [],
      now,
      intervalMinutes: 1,
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(
      slots.every(
        (s) => s.startAt.getTime() >= now.getTime() + 10 * 60_000,
      ),
    ).toBe(true);
    expect(
      slots.some(
        (s) => s.startAt.getTime() === now.getTime() + 9 * 60_000,
      ),
    ).toBe(false);
  });

  it('enforces maximum 30-day horizon', () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    // Horizon end = Colombo 2026-10-01 end of day
    const inside = calculator.buildUtcWindows({
      fromDateIso: '2026-10-01',
      toDateIso: '2026-10-01',
      weekly: [weekly(DayOfWeek.THURSDAY, '10:00', '12:00')],
      exceptions: [],
      now,
    });
    expect(inside.length).toBeGreaterThan(0);

    const outside = calculator.buildUtcWindows({
      fromDateIso: '2026-10-02',
      toDateIso: '2026-10-02',
      weekly: [weekly(DayOfWeek.FRIDAY, '10:00', '12:00')],
      exceptions: [],
      now,
    });
    expect(outside).toEqual([]);
  });

  it('expands occupied intervals by 10-minute buffer for conflicts', () => {
    const occupied = calculator.expandOccupiedWithBuffer({
      startAt: new Date('2026-09-21T04:30:00.000Z'), // 10:00 Colombo
      endAt: new Date('2026-09-21T05:00:00.000Z'), // 10:30 Colombo
    });
    expect(occupied.startAt.toISOString()).toBe('2026-09-21T04:20:00.000Z');
    expect(occupied.endAt.toISOString()).toBe('2026-09-21T05:10:00.000Z');
  });

  it('detects overlapping weekly windows', () => {
    expect(
      calculator.weeklyWindowsOverlap('09:00', '12:00', '11:00', '14:00'),
    ).toBe(true);
    expect(
      calculator.weeklyWindowsOverlap('09:00', '12:00', '12:00', '14:00'),
    ).toBe(false);
  });
});

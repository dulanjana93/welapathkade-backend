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

  it('enforces minimum 1-hour lead time', () => {
    // Monday 09:00–12:00 Colombo = 03:30–06:30 UTC
    // now = 03:00 UTC → lead cutoff 04:00 UTC → clamp start
    const windows = calculator.buildUtcWindows({
      fromDateIso: '2026-09-21',
      toDateIso: '2026-09-21',
      weekly: [weekly(DayOfWeek.MONDAY, '09:00', '12:00')],
      exceptions: [],
      now: new Date('2026-09-21T03:00:00.000Z'),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].startAt.toISOString()).toBe('2026-09-21T04:00:00.000Z');
    expect(windows[0].endAt.toISOString()).toBe('2026-09-21T06:30:00.000Z');
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

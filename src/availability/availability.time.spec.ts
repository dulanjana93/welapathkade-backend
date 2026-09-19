import { BadRequestException } from '@nestjs/common';
import { DayOfWeek } from '@prisma/client';
import {
  assertNoOverlaps,
  assertValidWindow,
  dayKeyToEnum,
  localColomboToUtc,
  parseLocalTime,
} from './availability.time';

describe('availability.time', () => {
  it('parses valid HH:mm', () => {
    expect(parseLocalTime('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseLocalTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects invalid time', () => {
    expect(() => parseLocalTime('9:00')).toThrow(BadRequestException);
    expect(() => parseLocalTime('24:00')).toThrow(BadRequestException);
    expect(() => parseLocalTime('12:60')).toThrow(BadRequestException);
  });

  it('rejects zero-length and inverted windows', () => {
    expect(() => assertValidWindow('09:00', '09:00')).toThrow(
      BadRequestException,
    );
    expect(() => assertValidWindow('12:00', '09:00')).toThrow(
      BadRequestException,
    );
  });

  it('rejects overlapping windows on same day', () => {
    expect(() =>
      assertNoOverlaps([
        { startTime: '09:00', endTime: '12:00' },
        { startTime: '11:30', endTime: '14:00' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('allows multiple non-overlapping windows', () => {
    expect(() =>
      assertNoOverlaps([
        { startTime: '09:00', endTime: '12:00' },
        { startTime: '14:00', endTime: '18:00' },
      ]),
    ).not.toThrow();
  });

  it('rejects invalid weekday keys', () => {
    expect(() => dayKeyToEnum('funday')).toThrow(BadRequestException);
    expect(dayKeyToEnum('monday')).toBe(DayOfWeek.MONDAY);
  });

  it('Colombo→UTC around midnight boundary', () => {
    // 00:30 Colombo = previous calendar day 19:00 UTC
    expect(localColomboToUtc('2026-09-22', '00:30').toISOString()).toBe(
      '2026-09-21T19:00:00.000Z',
    );
  });
});

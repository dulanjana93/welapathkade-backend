import { BadRequestException } from '@nestjs/common';
import { DayOfWeek } from '@prisma/client';
import { DateTime } from 'luxon';
import { BUSINESS_TIMEZONE } from './availability.constants';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

const DAY_KEY_TO_ENUM: Record<DayKey, DayOfWeek> = {
  monday: DayOfWeek.MONDAY,
  tuesday: DayOfWeek.TUESDAY,
  wednesday: DayOfWeek.WEDNESDAY,
  thursday: DayOfWeek.THURSDAY,
  friday: DayOfWeek.FRIDAY,
  saturday: DayOfWeek.SATURDAY,
  sunday: DayOfWeek.SUNDAY,
};

const ENUM_TO_DAY_KEY: Record<DayOfWeek, DayKey> = {
  [DayOfWeek.MONDAY]: 'monday',
  [DayOfWeek.TUESDAY]: 'tuesday',
  [DayOfWeek.WEDNESDAY]: 'wednesday',
  [DayOfWeek.THURSDAY]: 'thursday',
  [DayOfWeek.FRIDAY]: 'friday',
  [DayOfWeek.SATURDAY]: 'saturday',
  [DayOfWeek.SUNDAY]: 'sunday',
};

export function dayKeyToEnum(key: string): DayOfWeek {
  const normalized = key.toLowerCase() as DayKey;
  const value = DAY_KEY_TO_ENUM[normalized];
  if (!value) {
    throw new BadRequestException(`Invalid weekday: ${key}`);
  }
  return value;
}

export function dayEnumToKey(day: DayOfWeek): DayKey {
  return ENUM_TO_DAY_KEY[day];
}

export function luxonWeekdayToEnum(weekday: number): DayOfWeek {
  // Luxon: 1=Monday … 7=Sunday
  const map: Record<number, DayOfWeek> = {
    1: DayOfWeek.MONDAY,
    2: DayOfWeek.TUESDAY,
    3: DayOfWeek.WEDNESDAY,
    4: DayOfWeek.THURSDAY,
    5: DayOfWeek.FRIDAY,
    6: DayOfWeek.SATURDAY,
    7: DayOfWeek.SUNDAY,
  };
  return map[weekday];
}

export function parseLocalTime(value: string): {
  hour: number;
  minute: number;
} {
  const match = TIME_RE.exec(value.trim());
  if (!match) {
    throw new BadRequestException(
      `Invalid time "${value}". Expected HH:mm (00:00–23:59)`,
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function timeToMinutes(value: string): number {
  const { hour, minute } = parseLocalTime(value);
  return hour * 60 + minute;
}

export function assertValidWindow(startTime: string, endTime: string): void {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start >= end) {
    throw new BadRequestException(
      `Invalid window ${startTime}–${endTime}: start must be before end`,
    );
  }
}

/** True if [aStart,aEnd) overlaps [bStart,bEnd) on the same day (minute ranges). */
export function windowsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const as = timeToMinutes(aStart);
  const ae = timeToMinutes(aEnd);
  const bs = timeToMinutes(bStart);
  const be = timeToMinutes(bEnd);
  return as < be && ae > bs;
}

export function assertNoOverlaps(
  windows: Array<{ startTime: string; endTime: string }>,
): void {
  for (let i = 0; i < windows.length; i += 1) {
    assertValidWindow(windows[i].startTime, windows[i].endTime);
    for (let j = i + 1; j < windows.length; j += 1) {
      if (
        windowsOverlap(
          windows[i].startTime,
          windows[i].endTime,
          windows[j].startTime,
          windows[j].endTime,
        )
      ) {
        throw new BadRequestException(
          `Overlapping windows: ${windows[i].startTime}–${windows[i].endTime} and ${windows[j].startTime}–${windows[j].endTime}`,
        );
      }
    }
  }
}

/** Parse YYYY-MM-DD as an Asia/Colombo calendar date (noon local to avoid DST edge). */
export function parseColomboDate(isoDate: string): DateTime {
  const dt = DateTime.fromISO(isoDate, { zone: BUSINESS_TIMEZONE });
  if (!dt.isValid || isoDate.length < 10) {
    throw new BadRequestException(
      `Invalid date "${isoDate}". Expected YYYY-MM-DD`,
    );
  }
  return DateTime.fromObject(
    { year: dt.year, month: dt.month, day: dt.day },
    { zone: BUSINESS_TIMEZONE },
  ).startOf('day');
}

/** Store DATE column as UTC midnight of the calendar y/m/d (Prisma Date convention). */
export function colomboDateToDbDate(isoDate: string): Date {
  const d = parseColomboDate(isoDate);
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

export function dbDateToIso(date: Date): string {
  // Prisma returns DATE as UTC midnight for the calendar day.
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Convert a Colombo local calendar date + HH:mm to a UTC JS Date.
 */
export function localColomboToUtc(isoDate: string, hhmm: string): Date {
  const { hour, minute } = parseLocalTime(hhmm);
  const d = parseColomboDate(isoDate);
  const local = d.set({ hour, minute, second: 0, millisecond: 0 });
  if (!local.isValid) {
    throw new BadRequestException('Invalid local datetime');
  }
  return local.toUTC().toJSDate();
}

export function nowInColombo(now: Date = new Date()): DateTime {
  return DateTime.fromJSDate(now, { zone: 'utc' }).setZone(BUSINESS_TIMEZONE);
}

import { Injectable } from '@nestjs/common';
import {
  AvailabilityExceptionType,
  DayOfWeek,
  type AvailabilityException,
  type WeeklyAvailability,
} from '@prisma/client';
import { DateTime } from 'luxon';
import {
  APPOINTMENT_BUFFER_MINUTES,
  BUSINESS_TIMEZONE,
  MAX_BOOKING_HORIZON_DAYS,
  MIN_BOOKING_LEAD_MINUTES,
  SCHEDULING_INTERVAL_MINUTES,
} from './availability.constants';
import {
  dbDateToIso,
  localColomboToUtc,
  luxonWeekdayToEnum,
  nowInColombo,
  timeToMinutes,
  windowsOverlap,
} from './availability.time';

export type OccupiedInterval = {
  /** Inclusive start (UTC). */
  startAt: Date;
  /** Exclusive or inclusive end (UTC) — treated as exclusive for overlap math. */
  endAt: Date;
};

export type UtcWindow = {
  startAt: Date;
  endAt: Date;
  localDate: string;
  startTime: string;
  endTime: string;
};

export type AvailableSlot = {
  startAt: Date;
  endAt: Date;
  localDate: string;
  startTime: string;
  endTime: string;
};

function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Pure availability calculation (weekly + exceptions → UTC windows/slots).
 *
 * Occupied intervals (future appointments/reservations) are injectable so
 * Phase 4+ can subtract bookings without rewriting this module.
 *
 * Buffer note: APPOINTMENT_BUFFER_MINUTES is applied when checking occupied
 * intervals (expand occupied by buffer), not by shrinking willingness windows.
 */
@Injectable()
export class AvailabilityCalculator {
  /**
   * Effective local HH:mm windows for one Asia/Colombo calendar date.
   */
  resolveLocalWindowsForDate(params: {
    dateIso: string;
    weekly: WeeklyAvailability[];
    exceptions: AvailabilityException[];
  }): Array<{ startTime: string; endTime: string }> {
    const dayEnum = luxonWeekdayToEnum(
      DateTime.fromISO(params.dateIso, { zone: BUSINESS_TIMEZONE }).weekday,
    );

    const dayExceptions = params.exceptions.filter(
      (e) => dbDateToIso(e.date) === params.dateIso,
    );

    const unavailable = dayExceptions.filter(
      (e) => e.type === AvailabilityExceptionType.UNAVAILABLE,
    );
    if (unavailable.length > 0) {
      return [];
    }

    const overrides = dayExceptions.filter(
      (e) =>
        e.type === AvailabilityExceptionType.AVAILABLE_OVERRIDE &&
        e.startTime &&
        e.endTime,
    );
    if (overrides.length > 0) {
      return overrides.map((o) => ({
        startTime: o.startTime!,
        endTime: o.endTime!,
      }));
    }

    return params.weekly
      .filter((w) => w.dayOfWeek === dayEnum)
      .map((w) => ({ startTime: w.startTime, endTime: w.endTime }));
  }

  /**
   * Convert local willingness windows to UTC ranges for a date range.
   */
  buildUtcWindows(params: {
    fromDateIso: string;
    toDateIso: string;
    weekly: WeeklyAvailability[];
    exceptions: AvailabilityException[];
    now?: Date;
    minLeadMinutes?: number;
  }): UtcWindow[] {
    const now = params.now ?? new Date();
    const minLeadMinutes = params.minLeadMinutes ?? MIN_BOOKING_LEAD_MINUTES;
    const leadCutoff = DateTime.fromJSDate(now, { zone: 'utc' }).plus({
      minutes: minLeadMinutes,
    });
    const horizonEnd = nowInColombo(now)
      .startOf('day')
      .plus({ days: MAX_BOOKING_HORIZON_DAYS })
      .endOf('day');

    let cursor = DateTime.fromISO(params.fromDateIso, {
      zone: BUSINESS_TIMEZONE,
    }).startOf('day');
    const end = DateTime.fromISO(params.toDateIso, {
      zone: BUSINESS_TIMEZONE,
    }).startOf('day');

    if (!cursor.isValid || !end.isValid || cursor > end) {
      return [];
    }

    const windows: UtcWindow[] = [];
    while (cursor <= end) {
      if (cursor > horizonEnd) break;
      const dateIso = cursor.toISODate();
      const localWindows = this.resolveLocalWindowsForDate({
        dateIso,
        weekly: params.weekly,
        exceptions: params.exceptions,
      });

      for (const w of localWindows) {
        let startAt = localColomboToUtc(dateIso, w.startTime);
        const endAt = localColomboToUtc(dateIso, w.endTime);
        const startDt = DateTime.fromJSDate(startAt, { zone: 'utc' });
        if (startDt < leadCutoff) {
          // Clamp window start to lead-time boundary (rounded up to next minute).
          startAt = leadCutoff.toUTC().toJSDate();
        }
        if (startAt < endAt) {
          windows.push({
            startAt,
            endAt,
            localDate: dateIso,
            startTime: w.startTime,
            endTime: w.endTime,
          });
        }
      }

      cursor = cursor.plus({ days: 1 });
    }

    return windows;
  }

  /**
   * Enumerate bookable slots of fixed duration inside effective windows,
   * subtracting occupied intervals (with scheduling buffer expansion).
   */
  enumerateSlots(params: {
    fromDateIso: string;
    toDateIso: string;
    durationMinutes: number;
    weekly: WeeklyAvailability[];
    exceptions: AvailabilityException[];
    occupied?: OccupiedInterval[];
    now?: Date;
    intervalMinutes?: number;
    bufferMinutes?: number;
    minLeadMinutes?: number;
  }): AvailableSlot[] {
    const duration = params.durationMinutes;
    const interval = params.intervalMinutes ?? SCHEDULING_INTERVAL_MINUTES;
    const buffer = params.bufferMinutes ?? APPOINTMENT_BUFFER_MINUTES;
    const occupied = params.occupied ?? [];

    const utcWindows = this.buildUtcWindows({
      fromDateIso: params.fromDateIso,
      toDateIso: params.toDateIso,
      weekly: params.weekly,
      exceptions: params.exceptions,
      now: params.now,
      minLeadMinutes: params.minLeadMinutes,
    });

    const slots: AvailableSlot[] = [];
    for (const window of utcWindows) {
      let cursor = DateTime.fromJSDate(window.startAt, { zone: 'utc' });
      const windowEnd = DateTime.fromJSDate(window.endAt, { zone: 'utc' });

      while (cursor.plus({ minutes: duration }) <= windowEnd) {
        const slotStart = cursor.toJSDate();
        const slotEnd = cursor.plus({ minutes: duration }).toJSDate();

        const conflicts = occupied.some((occ) => {
          const occStart = DateTime.fromJSDate(occ.startAt, {
            zone: 'utc',
          }).minus({
            minutes: buffer,
          });
          const occEnd = DateTime.fromJSDate(occ.endAt, { zone: 'utc' }).plus({
            minutes: buffer,
          });
          // Overlap: existing.start < requested.end AND existing.end > requested.start
          return occStart.toJSDate() < slotEnd && occEnd.toJSDate() > slotStart;
        });

        if (!conflicts) {
          const localStart = DateTime.fromJSDate(slotStart, {
            zone: 'utc',
          }).setZone(BUSINESS_TIMEZONE);
          slots.push({
            startAt: slotStart,
            endAt: slotEnd,
            localDate: localStart.toISODate()!,
            startTime: localStart.toFormat('HH:mm'),
            endTime: localStart.plus({ minutes: duration }).toFormat('HH:mm'),
          });
        }

        cursor = cursor.plus({ minutes: interval });
      }
    }

    return slots;
  }

  /** Expand occupied interval by buffer for conflict checks (utility for later phases). */
  expandOccupiedWithBuffer(
    occupied: OccupiedInterval,
    bufferMinutes: number = APPOINTMENT_BUFFER_MINUTES,
  ): OccupiedInterval {
    return {
      startAt: DateTime.fromJSDate(occupied.startAt, { zone: 'utc' })
        .minus({ minutes: bufferMinutes })
        .toJSDate(),
      endAt: DateTime.fromJSDate(occupied.endAt, { zone: 'utc' })
        .plus({ minutes: bufferMinutes })
        .toJSDate(),
    };
  }

  intervalsOverlap(a: OccupiedInterval, b: OccupiedInterval): boolean {
    return a.startAt < b.endAt && a.endAt > b.startAt;
  }

  /** Test helper: weekly day enum for a Colombo date. */
  dayOfWeekForDate(dateIso: string): DayOfWeek {
    return luxonWeekdayToEnum(
      DateTime.fromISO(dateIso, { zone: BUSINESS_TIMEZONE }).weekday,
    );
  }

  /** Expose overlap helper for weekly validation tests. */
  weeklyWindowsOverlap(
    aStart: string,
    aEnd: string,
    bStart: string,
    bEnd: string,
  ): boolean {
    return windowsOverlap(aStart, aEnd, bStart, bEnd);
  }

  timeToMinutes(value: string): number {
    return timeToMinutes(value);
  }

  minutesToHhmm(total: number): string {
    return minutesToHhmm(total);
  }
}

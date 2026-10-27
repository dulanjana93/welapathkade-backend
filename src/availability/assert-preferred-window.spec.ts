import { BadRequestException } from '@nestjs/common';
import { AvailabilityExceptionType, DayOfWeek } from '@prisma/client';
import { DateTime } from 'luxon';
import { AvailabilityCalculator } from './availability.calculator';
import {
  BUSINESS_TIMEZONE,
  MAX_PREFERRED_WINDOW_MINUTES,
} from './availability.constants';
import { AvailabilityService } from './availability.service';

describe('AvailabilityService.assertPreferredSlotEligible', () => {
  const calculator = new AvailabilityCalculator();
  let service: AvailabilityService;
  let weekly: Array<{
    id: string;
    astrologerId: string;
    dayOfWeek: DayOfWeek;
    startTime: string;
    endTime: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  let exceptions: Array<{
    id: string;
    astrologerId: string;
    date: Date;
    type: AvailabilityExceptionType;
    startTime: string | null;
    endTime: string | null;
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

  const profile = {
    id: 'astro-1',
    status: 'ACTIVE',
    user: { status: 'ACTIVE' },
  };

  beforeEach(() => {
    weekly = [
      {
        id: 'w1',
        astrologerId: 'astro-1',
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '17:00',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'w2',
        astrologerId: 'astro-1',
        dayOfWeek: DayOfWeek.SUNDAY,
        startTime: '09:00',
        endTime: '17:00',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    exceptions = [];

    const prisma = {
      astrologerProfile: {
        findUnique: jest.fn().mockResolvedValue(profile),
      },
      weeklyAvailability: {
        findMany: jest.fn().mockImplementation(async () => weekly),
      },
      availabilityException: {
        findMany: jest.fn().mockImplementation(async () => exceptions),
      },
    };

    const config = {
      get: jest.fn((key: string) => {
        if (key === 'app.nodeEnv') return 'development';
        return undefined;
      }),
    };
    service = new AvailabilityService(
      prisma as never,
      calculator,
      {} as never,
      {} as never,
      config as never,
    );
  });

  function nextWeekdayAt(weekday: number, hour: number, minute = 0): Date {
    let day = DateTime.now().setZone(BUSINESS_TIMEZONE).plus({ days: 1 });
    while (day.weekday !== weekday) {
      day = day.plus({ days: 1 });
    }
    return day
      .set({ hour, minute, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
  }

  it('accepts a multi-hour preference range that overlaps weekly availability', async () => {
    const start = nextWeekdayAt(1, 9, 0);
    const end = nextWeekdayAt(1, 12, 0);
    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a preference that is not aligned to the 30-minute slot grid', async () => {
    const start = nextWeekdayAt(1, 9, 15);
    const end = nextWeekdayAt(1, 11, 45);
    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a preference whose start is already past when the range still has future time', async () => {
    // Reproduce the MVP bug: today afternoon 13:00–17:00 at ~13:08 Colombo.
    const now = DateTime.fromISO('2026-10-11T13:08:00', {
      zone: BUSINESS_TIMEZONE,
    }).toUTC();
    const start = DateTime.fromISO('2026-10-11T13:00:00', {
      zone: BUSINESS_TIMEZONE,
    })
      .toUTC()
      .toJSDate();
    const end = DateTime.fromISO('2026-10-11T17:00:00', {
      zone: BUSINESS_TIMEZONE,
    })
      .toUTC()
      .toJSDate();

    // Sunday 2026-10-11 — ensure Sunday weekly window is present (seeded above).
    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
        now: now.toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a preference window that has already fully ended', async () => {
    const now = DateTime.fromISO('2026-10-11T17:30:00', {
      zone: BUSINESS_TIMEZONE,
    }).toUTC();
    const start = DateTime.fromISO('2026-10-11T13:00:00', {
      zone: BUSINESS_TIMEZONE,
    })
      .toUTC()
      .toJSDate();
    const end = DateTime.fromISO('2026-10-11T17:00:00', {
      zone: BUSINESS_TIMEZONE,
    })
      .toUTC()
      .toJSDate();

    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
        now: now.toJSDate(),
      }),
    ).rejects.toThrow(/already ended/);
  });

  it('rejects a preference outside weekly windows with a specific message', async () => {
    const start = nextWeekdayAt(1, 3, 0);
    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: nextWeekdayAt(1, 4, 0),
      }),
    ).rejects.toThrow(/does not overlap/);
  });

  it('rejects an oversized preference window', async () => {
    const start = nextWeekdayAt(1, 9, 0);
    const end = nextWeekdayAt(1, 21, 30);
    expect((end.getTime() - start.getTime()) / 60_000).toBeGreaterThan(
      MAX_PREFERRED_WINDOW_MINUTES,
    );
    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
      }),
    ).rejects.toThrow(/Preferred window duration/);
  });

  it('rejects unavailable exception dates with a specific message', async () => {
    const start = nextWeekdayAt(1, 10, 0);
    const end = nextWeekdayAt(1, 12, 0);
    const dateIso = DateTime.fromJSDate(start, { zone: 'utc' })
      .setZone(BUSINESS_TIMEZONE)
      .toISODate()!;
    const [y, m, d] = dateIso.split('-').map(Number);
    exceptions.push({
      id: 'ex1',
      astrologerId: 'astro-1',
      date: new Date(Date.UTC(y, m - 1, d)),
      type: AvailabilityExceptionType.UNAVAILABLE,
      startTime: null,
      endTime: null,
      reason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
      }),
    ).rejects.toThrow(/no availability on the preferred date/);
  });

  it('does not apply appointment min-lead to preference start', async () => {
    const now = DateTime.fromISO('2026-10-12T10:00:00', {
      zone: BUSINESS_TIMEZONE,
    }).toUTC();
    // Monday 2026-10-12
    const start = DateTime.fromISO('2026-10-12T10:15:00', {
      zone: BUSINESS_TIMEZONE,
    })
      .toUTC()
      .toJSDate();
    const end = DateTime.fromISO('2026-10-12T12:00:00', {
      zone: BUSINESS_TIMEZONE,
    })
      .toUTC()
      .toJSDate();

    await expect(
      service.assertPreferredSlotEligible({
        astrologerId: 'astro-1',
        preferredStartAt: start,
        preferredEndAt: end,
        now: now.toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });
});

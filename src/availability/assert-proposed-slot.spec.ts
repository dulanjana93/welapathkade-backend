import { BadRequestException } from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AvailabilityExceptionType,
  DayOfWeek,
  UserStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AvailabilityCalculator } from './availability.calculator';
import {
  BUSINESS_TIMEZONE,
  MAX_APPOINTMENT_DURATION_MINUTES,
  MIN_APPOINTMENT_DURATION_MINUTES,
} from './availability.constants';
import { AvailabilityService } from './availability.service';
import { colomboDateToDbDate, localColomboToUtc } from './availability.time';

describe('AvailabilityService.assertProposedSlotEligible', () => {
  const calculator = new AvailabilityCalculator();
  const prisma = {
    astrologerProfile: { findUnique: jest.fn() },
    weeklyAvailability: { findMany: jest.fn() },
    availabilityException: { findMany: jest.fn() },
  };
  const bookingGuard = {
    ensureGuard: jest.fn(),
    withAstrologerLock: jest.fn(),
  };
  const occupancy = { loadOccupiedIntervals: jest.fn().mockResolvedValue([]) };
  const configState = {
    nodeEnv: 'development' as string | undefined,
    allowShortNotice: undefined as string | undefined,
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'app.nodeEnv') return configState.nodeEnv;
      if (key === 'app.allowShortNoticeTestAppointments') {
        return configState.allowShortNotice;
      }
      return undefined;
    }),
  };

  const service = new AvailabilityService(
    prisma as never,
    calculator,
    bookingGuard as never,
    occupancy as never,
    config as never,
  );

  const futureMonday = DateTime.now()
    .setZone(BUSINESS_TIMEZONE)
    .plus({ days: 1 })
    .startOf('week') // Monday in Luxon
    .plus({ weeks: 1 });

  const dateIso = futureMonday.toISODate()!;
  const validStart = localColomboToUtc(dateIso, '10:00');

  beforeEach(() => {
    jest.clearAllMocks();
    configState.nodeEnv = 'development';
    configState.allowShortNotice = undefined;
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      status: AstrologerProfileStatus.ACTIVE,
      user: { status: UserStatus.ACTIVE },
    });
    prisma.weeklyAvailability.findMany.mockResolvedValue([
      {
        id: 'w1',
        astrologerId: 'ap-1',
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '12:00',
      },
    ]);
    prisma.availabilityException.findMany.mockResolvedValue([]);
  });

  it('converts 13:45 Asia/Colombo to 08:15 UTC', () => {
    const utc = localColomboToUtc('2026-10-11', '13:45');
    expect(utc.toISOString()).toBe('2026-10-11T08:15:00.000Z');
    const local = DateTime.fromJSDate(utc, { zone: 'utc' }).setZone(
      BUSINESS_TIMEZONE,
    );
    expect(local.toISODate()).toBe('2026-10-11');
    expect(local.toFormat('HH:mm')).toBe('13:45');
  });

  it('accepts a start that lands on an enumerated slot', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: validStart,
        durationMinutes: 30,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a non-grid-aligned custom start such as 10:35', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '10:35'),
        durationMinutes: 30,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts 13:35 when the weekly window covers the full duration', async () => {
    prisma.weeklyAvailability.findMany.mockResolvedValue([
      {
        id: 'w1',
        astrologerId: 'ap-1',
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '17:00',
      },
    ]);
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '13:35'),
        durationMinutes: 45,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects when duration would leave the availability window', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '11:40'),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects conflicting occupied intervals with buffer', async () => {
    const occupiedStart = localColomboToUtc(dateIso, '10:00');
    const occupiedEnd = localColomboToUtc(dateIso, '10:30');
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '10:35'),
        durationMinutes: 30,
        occupied: [{ startAt: occupiedStart, endAt: occupiedEnd }],
      }),
    ).rejects.toThrow(/conflicts/);
  });

  function sundayWindow() {
    prisma.weeklyAvailability.findMany.mockResolvedValue([
      {
        id: 'w1',
        astrologerId: 'ap-1',
        dayOfWeek: DayOfWeek.SUNDAY,
        startTime: '09:00',
        endTime: '17:00',
      },
    ]);
  }

  it('accepts a proposal exactly 5 minutes ahead', async () => {
    const now = DateTime.fromISO('2026-10-11T13:55:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '14:00'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a proposal 4 minutes ahead', async () => {
    const now = DateTime.fromISO('2026-10-11T13:56:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '14:00'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).rejects.toThrow(/at least 5 minutes from now/);
  });

  it('rejects a proposal in the past', async () => {
    const now = DateTime.fromISO('2026-10-11T14:00:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '13:45'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).rejects.toThrow(/in the past/);
  });

  it('accepts a proposal 60 minutes ahead', async () => {
    const now = DateTime.fromISO('2026-10-11T13:00:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '14:00'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });

  it('proposal lead stays 5 minutes when short-notice override is disabled', async () => {
    configState.allowShortNotice = 'false';
    configState.nodeEnv = 'development';
    const now = DateTime.fromISO('2026-10-11T13:55:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '14:00'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });

  it('proposal lead stays 5 minutes in production (flag ignored for proposals)', async () => {
    configState.allowShortNotice = 'true';
    configState.nodeEnv = 'production';
    const now = DateTime.fromISO('2026-10-11T13:55:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '14:00'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects the former reproduction case only when under 5 minutes (13:45 vs 13:41)', async () => {
    const now = DateTime.fromISO('2026-10-11T13:41:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    // 4 minutes ahead — still rejected under the 5-minute rule
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '13:45'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).rejects.toThrow(/at least 5 minutes from now/);
  });

  it('accepts a same-day custom start more than 5 minutes ahead', async () => {
    const now = DateTime.fromISO('2026-10-11T13:41:00', {
      zone: BUSINESS_TIMEZONE,
    });
    sundayWindow();
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc('2026-10-11', '14:45'),
        durationMinutes: 15,
        now: now.toUTC().toJSDate(),
      }),
    ).resolves.toBeUndefined();
  });

  it('4. rejects beyond 30-day horizon', async () => {
    const far = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 40 })
      .startOf('week')
      .plus({ weeks: 0 });
    const farIso = far.toISODate()!;
    prisma.weeklyAvailability.findMany.mockResolvedValue([
      {
        id: 'w1',
        astrologerId: 'ap-1',
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '17:00',
      },
    ]);
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(farIso, '10:00'),
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/booking horizon/);
  });

  it('5. rejects outside weekly availability', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '14:00'),
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/outside the astrologer availability/);
  });

  it('6. rejects crossing availability boundary', async () => {
    // 11:45 + 30m = 12:15 would cross 12:00 end
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '11:45'),
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/outside the astrologer availability/);
  });

  it('7. rejects unavailable exception', async () => {
    prisma.availabilityException.findMany.mockResolvedValue([
      {
        id: 'e1',
        astrologerId: 'ap-1',
        date: colomboDateToDbDate(dateIso),
        type: AvailabilityExceptionType.UNAVAILABLE,
        startTime: null,
        endTime: null,
        reason: 'Holiday',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: validStart,
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/no availability on the proposed date/);
  });

  it('8. rejects invalid duration', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: validStart,
        durationMinutes: 0,
      }),
    ).rejects.toThrow(/durationMinutes/);

    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: validStart,
        durationMinutes: -10,
      }),
    ).rejects.toThrow(/durationMinutes/);

    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: validStart,
        durationMinutes: MAX_APPOINTMENT_DURATION_MINUTES + 1,
      }),
    ).rejects.toThrow(
      new RegExp(
        `${MIN_APPOINTMENT_DURATION_MINUTES}.*${MAX_APPOINTMENT_DURATION_MINUTES}`,
      ),
    );
  });
});

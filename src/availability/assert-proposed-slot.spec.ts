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
import { localColomboToUtc } from './availability.time';

describe('AvailabilityService.assertProposedSlotEligible', () => {
  const calculator = new AvailabilityCalculator();
  const prisma = {
    astrologerProfile: { findUnique: jest.fn() },
    weeklyAvailability: { findMany: jest.fn() },
    availabilityException: { findMany: jest.fn() },
  };
  const bookingGuard = { ensureGuard: jest.fn(), withAstrologerLock: jest.fn() };
  const occupancy = { loadOccupiedIntervals: jest.fn().mockResolvedValue([]) };

  const service = new AvailabilityService(
    prisma as never,
    calculator,
    bookingGuard as never,
    occupancy as never,
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

  it('accepts a start that lands on an enumerated slot', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: validStart,
        durationMinutes: 30,
      }),
    ).resolves.toBeUndefined();
  });

  it('3. rejects less than 1h lead', async () => {
    const soon = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ minutes: 30 });
    // Align to a weekly window if needed by mocking today as Monday with open window
    prisma.weeklyAvailability.findMany.mockResolvedValue([
      {
        id: 'w1',
        astrologerId: 'ap-1',
        dayOfWeek: calculator.dayOfWeekForDate(soon.toISODate()!),
        startTime: '00:00',
        endTime: '23:59',
      },
    ]);
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: soon.toUTC().toJSDate(),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
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
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('5. rejects outside weekly availability', async () => {
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '14:00'),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('6. rejects crossing availability boundary', async () => {
    // 11:45 + 30m = 12:15 would cross 12:00 end — slot enum won't include it
    await expect(
      service.assertProposedSlotEligible({
        astrologerId: 'ap-1',
        proposedStartAt: localColomboToUtc(dateIso, '11:45'),
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('7. rejects unavailable exception', async () => {
    prisma.availabilityException.findMany.mockResolvedValue([
      {
        id: 'e1',
        astrologerId: 'ap-1',
        date: new Date(`${dateIso}T00:00:00.000Z`),
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
    ).rejects.toBeInstanceOf(BadRequestException);
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

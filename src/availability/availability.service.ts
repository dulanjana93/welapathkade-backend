import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AvailabilityExceptionType,
  AstrologerProfileStatus,
  DayOfWeek,
  User,
  UserRole,
  UserStatus,
  type AvailabilityException,
  type WeeklyAvailability,
} from '@prisma/client';
import {
  isShortNoticeTestAppointmentsEnabled,
  resolveProposalMinLeadMinutes,
} from '../config/short-notice-test-appointments';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityCalculator } from './availability.calculator';
import {
  APPOINTMENT_BUFFER_MINUTES,
  BUSINESS_TIMEZONE,
  MAX_APPOINTMENT_DURATION_MINUTES,
  MAX_BOOKING_HORIZON_DAYS,
  MAX_PREFERRED_WINDOW_MINUTES,
  MIN_APPOINTMENT_DURATION_MINUTES,
} from './availability.constants';
import { BookingGuardService } from './booking-guard.service';
import { OccupancyService } from './occupancy.service';
import {
  CreateAvailabilityExceptionDto,
  PutWeeklyAvailabilityDto,
  UpdateAvailabilityExceptionDto,
  WeeklyWindowInputDto,
} from './dto/availability.dto';
import { DateTime } from 'luxon';
import {
  DAY_KEYS,
  assertNoOverlaps,
  assertValidWindow,
  colomboDateToDbDate,
  dayEnumToKey,
  dayKeyToEnum,
  dbDateToIso,
  nowInColombo,
  timeToMinutes,
  windowsOverlap,
  type DayKey,
} from './availability.time';
import type { OccupiedInterval } from './availability.calculator';

function minutesToHhmm(total: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, total));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: AvailabilityCalculator,
    private readonly bookingGuard: BookingGuardService,
    private readonly occupancy: OccupancyService,
    private readonly config: ConfigService,
  ) {}

  /** Effective proposal lead; 5 minutes only under the explicit test override. */
  private effectiveProposalMinLeadMinutes(): number {
    return resolveProposalMinLeadMinutes(
      this.config.get<string>('app.allowShortNoticeTestAppointments'),
      this.config.get<string>('app.nodeEnv'),
    );
  }

  private shortNoticeTestAppointmentsEnabled(): boolean {
    return isShortNoticeTestAppointmentsEnabled(
      this.config.get<string>('app.allowShortNoticeTestAppointments'),
      this.config.get<string>('app.nodeEnv'),
    );
  }

  async ensureOwnProfile(user: User) {
    if (user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException('Astrologer role required');
    }
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }
    return profile;
  }

  async hasConfiguredAvailability(astrologerId: string): Promise<boolean> {
    const count = await this.prisma.weeklyAvailability.count({
      where: { astrologerId },
    });
    return count > 0;
  }

  async getScheduleForAstrologer(astrologerId: string) {
    const [weekly, exceptions] = await Promise.all([
      this.prisma.weeklyAvailability.findMany({
        where: { astrologerId },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      }),
      this.prisma.availabilityException.findMany({
        where: { astrologerId },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
    ]);
    return this.toScheduleView(weekly, exceptions);
  }

  async getOwnAvailability(user: User) {
    const profile = await this.ensureOwnProfile(user);
    return this.getScheduleForAstrologer(profile.id);
  }

  async putOwnWeeklyAvailability(user: User, dto: PutWeeklyAvailabilityDto) {
    const profile = await this.ensureOwnProfile(user);
    const rows: Array<{
      dayOfWeek: DayOfWeek;
      startTime: string;
      endTime: string;
    }> = [];

    for (const key of DAY_KEYS) {
      const windows = dto[key] ?? [];
      assertNoOverlaps(windows);
      for (const w of windows) {
        rows.push({
          dayOfWeek: dayKeyToEnum(key),
          startTime: w.startTime,
          endTime: w.endTime,
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.weeklyAvailability.deleteMany({
        where: { astrologerId: profile.id },
      });
      if (rows.length > 0) {
        await tx.weeklyAvailability.createMany({
          data: rows.map((r) => ({
            astrologerId: profile.id,
            dayOfWeek: r.dayOfWeek,
            startTime: r.startTime,
            endTime: r.endTime,
          })),
        });
      }
      await this.bookingGuard.ensureGuard(profile.id, tx);
    });

    return this.getScheduleForAstrologer(profile.id);
  }

  async listOwnExceptions(user: User) {
    const profile = await this.ensureOwnProfile(user);
    const rows = await this.prisma.availabilityException.findMany({
      where: { astrologerId: profile.id },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    return rows.map((e) => this.toExceptionView(e));
  }

  async createOwnException(user: User, dto: CreateAvailabilityExceptionDto) {
    const profile = await this.ensureOwnProfile(user);
    this.validateExceptionPayload(dto.type, dto.startTime, dto.endTime);

    const date = colomboDateToDbDate(dto.date);
    await this.assertExceptionCompatible(profile.id, date, dto);

    const created = await this.prisma.availabilityException.create({
      data: {
        astrologerId: profile.id,
        date,
        type: dto.type,
        startTime:
          dto.type === AvailabilityExceptionType.AVAILABLE_OVERRIDE
            ? dto.startTime!
            : null,
        endTime:
          dto.type === AvailabilityExceptionType.AVAILABLE_OVERRIDE
            ? dto.endTime!
            : null,
        reason: dto.reason?.trim() || null,
      },
    });
    return this.toExceptionView(created);
  }

  async updateOwnException(
    user: User,
    id: string,
    dto: UpdateAvailabilityExceptionDto,
  ) {
    const profile = await this.ensureOwnProfile(user);
    const existing = await this.prisma.availabilityException.findFirst({
      where: { id, astrologerId: profile.id },
    });
    if (!existing) {
      throw new NotFoundException('Availability exception not found');
    }

    const type = dto.type ?? existing.type;
    const startTime =
      type === AvailabilityExceptionType.UNAVAILABLE
        ? null
        : dto.startTime !== undefined
          ? dto.startTime
          : existing.startTime;
    const endTime =
      type === AvailabilityExceptionType.UNAVAILABLE
        ? null
        : dto.endTime !== undefined
          ? dto.endTime
          : existing.endTime;

    this.validateExceptionPayload(
      type,
      startTime ?? undefined,
      endTime ?? undefined,
    );

    if (type === AvailabilityExceptionType.AVAILABLE_OVERRIDE) {
      await this.assertOverrideNoOverlap(
        profile.id,
        existing.date,
        startTime!,
        endTime!,
        existing.id,
      );
    }

    if (type === AvailabilityExceptionType.UNAVAILABLE) {
      // Full-day unavailable replaces any other exceptions for that date.
      await this.prisma.availabilityException.deleteMany({
        where: {
          astrologerId: profile.id,
          date: existing.date,
          id: { not: existing.id },
        },
      });
    }

    const updated = await this.prisma.availabilityException.update({
      where: { id: existing.id },
      data: {
        type,
        startTime:
          type === AvailabilityExceptionType.AVAILABLE_OVERRIDE
            ? startTime
            : null,
        endTime:
          type === AvailabilityExceptionType.AVAILABLE_OVERRIDE
            ? endTime
            : null,
        reason:
          dto.reason !== undefined
            ? dto.reason?.trim() || null
            : existing.reason,
      },
    });
    return this.toExceptionView(updated);
  }

  async deleteOwnException(user: User, id: string) {
    const profile = await this.ensureOwnProfile(user);
    const existing = await this.prisma.availabilityException.findFirst({
      where: { id, astrologerId: profile.id },
    });
    if (!existing) {
      throw new NotFoundException('Availability exception not found');
    }
    await this.prisma.availabilityException.delete({ where: { id } });
    return { deleted: true };
  }

  async getPublicAvailability(astrologerId: string) {
    const profile = await this.requirePublicBookable(astrologerId);
    return this.getScheduleForAstrologer(profile.id);
  }

  async getPublicSlots(
    astrologerId: string,
    query: { from: string; to: string; durationMinutes?: number },
  ) {
    const profile = await this.requirePublicBookable(astrologerId);
    const duration = query.durationMinutes ?? 30;
    if (
      duration < MIN_APPOINTMENT_DURATION_MINUTES ||
      duration > MAX_APPOINTMENT_DURATION_MINUTES
    ) {
      throw new BadRequestException(
        `durationMinutes must be between ${MIN_APPOINTMENT_DURATION_MINUTES} and ${MAX_APPOINTMENT_DURATION_MINUTES}`,
      );
    }

    const [weekly, exceptions, occupied] = await Promise.all([
      this.prisma.weeklyAvailability.findMany({
        where: { astrologerId: profile.id },
      }),
      this.prisma.availabilityException.findMany({
        where: { astrologerId: profile.id },
      }),
      this.occupancy.loadOccupiedIntervals({ astrologerId: profile.id }),
    ]);

    const minLeadMinutes = this.effectiveProposalMinLeadMinutes();
    const shortNoticeTestAppointments =
      this.shortNoticeTestAppointmentsEnabled();
    const slots = this.calculator.enumerateSlots({
      fromDateIso: query.from,
      toDateIso: query.to,
      durationMinutes: duration,
      weekly,
      exceptions,
      occupied,
      minLeadMinutes,
    });

    return {
      timezone: BUSINESS_TIMEZONE,
      minLeadMinutes,
      maxHorizonDays: MAX_BOOKING_HORIZON_DAYS,
      shortNoticeTestAppointments,
      durationMinutes: duration,
      slots: slots.map((s) => ({
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        localDate: s.localDate,
        startTime: s.startTime,
        endTime: s.endTime,
      })),
    };
  }

  /**
   * Eligibility check only for a customer preference window.
   * Preference is NOT an appointment duration, reservation, or slot hold.
   * Does not require exact scheduling-interval slot alignment, occupancy clearance,
   * or the appointment min-lead rule on preferredStartAt (ranges may begin earlier
   * today as long as the window has not already ended).
   */
  async assertPreferredSlotEligible(params: {
    astrologerId: string;
    preferredStartAt: Date;
    preferredEndAt?: Date | null;
    now?: Date;
  }): Promise<void> {
    const profile = await this.requirePublicBookable(params.astrologerId);
    const now = params.now ?? new Date();
    const start = params.preferredStartAt;
    const end = params.preferredEndAt ?? null;

    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('preferredStartAt is invalid');
    }
    if (end && Number.isNaN(end.getTime())) {
      throw new BadRequestException('preferredEndAt is invalid');
    }
    if (end && end <= start) {
      throw new BadRequestException(
        'preferredEndAt must be after preferredStartAt',
      );
    }

    const localStart = DateTime.fromJSDate(start, { zone: 'utc' }).setZone(
      BUSINESS_TIMEZONE,
    );
    if (!localStart.isValid) {
      throw new BadRequestException('preferredStartAt is invalid');
    }

    const localEnd = end
      ? DateTime.fromJSDate(end, { zone: 'utc' }).setZone(BUSINESS_TIMEZONE)
      : null;
    if (localEnd && !localEnd.isValid) {
      throw new BadRequestException('preferredEndAt is invalid');
    }
    if (
      localEnd &&
      localEnd.startOf('day').toISODate() !== localStart.toISODate()
    ) {
      throw new BadRequestException(
        'preferredEndAt must be on the same Asia/Colombo calendar day as preferredStartAt',
      );
    }

    const durationMinutes = end
      ? Math.round((end.getTime() - start.getTime()) / 60_000)
      : MIN_APPOINTMENT_DURATION_MINUTES;
    if (
      durationMinutes < MIN_APPOINTMENT_DURATION_MINUTES ||
      durationMinutes > MAX_PREFERRED_WINDOW_MINUTES
    ) {
      throw new BadRequestException(
        `Preferred window duration must be between ${MIN_APPOINTMENT_DURATION_MINUTES} and ${MAX_PREFERRED_WINDOW_MINUTES} minutes`,
      );
    }

    // Preference windows may start earlier today; reject only once the whole
    // window is already in the past. Appointment min-lead still applies to proposals.
    const windowEndUtc = end
      ? DateTime.fromJSDate(end, { zone: 'utc' })
      : DateTime.fromJSDate(start, { zone: 'utc' }).plus({
          minutes: MIN_APPOINTMENT_DURATION_MINUTES,
        });
    if (windowEndUtc <= DateTime.fromJSDate(now, { zone: 'utc' })) {
      throw new BadRequestException(
        'Preferred time range has already ended. Choose a later range.',
      );
    }

    const horizonEnd = nowInColombo(now)
      .startOf('day')
      .plus({ days: MAX_BOOKING_HORIZON_DAYS });
    if (localStart.startOf('day') > horizonEnd) {
      throw new BadRequestException(
        `Preferred date is beyond the ${MAX_BOOKING_HORIZON_DAYS}-day booking horizon`,
      );
    }

    const todayColombo = nowInColombo(now).startOf('day');
    if (localStart.startOf('day') < todayColombo) {
      throw new BadRequestException(
        'Preferred date must be today or a future Asia/Colombo calendar day',
      );
    }

    const dateIso = localStart.toISODate();
    const [weekly, exceptions] = await Promise.all([
      this.prisma.weeklyAvailability.findMany({
        where: { astrologerId: profile.id },
      }),
      this.prisma.availabilityException.findMany({
        where: { astrologerId: profile.id },
      }),
    ]);

    const windows = this.calculator.resolveLocalWindowsForDate({
      dateIso,
      weekly,
      exceptions,
    });
    if (windows.length === 0) {
      throw new BadRequestException(
        'Astrologer has no availability on the preferred date',
      );
    }

    const prefStart = localStart.toFormat('HH:mm');
    const prefEnd = localEnd
      ? localEnd.toFormat('HH:mm')
      : minutesToHhmm(
          timeToMinutes(prefStart) + MIN_APPOINTMENT_DURATION_MINUTES,
        );

    const overlaps = windows.some((w) =>
      windowsOverlap(prefStart, prefEnd, w.startTime, w.endTime),
    );
    if (!overlaps) {
      throw new BadRequestException(
        'Preferred time range does not overlap the astrologer availability',
      );
    }
  }

  /**
   * Eligibility check for an astrologer-proposed appointment interval.
   * Does NOT reserve the slot or create an appointment/payment.
   *
   * Validates lead, horizon, weekly/exception fit, and occupancy buffer.
   * Start times are NOT required to align to the public slot grid.
   */
  async assertProposedSlotEligible(params: {
    astrologerId: string;
    proposedStartAt: Date;
    durationMinutes: number;
    occupied?: OccupiedInterval[];
    now?: Date;
  }): Promise<void> {
    const profile = await this.requirePublicBookable(params.astrologerId);
    const now = params.now ?? new Date();
    const start = params.proposedStartAt;
    const durationMinutes = params.durationMinutes;

    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('proposedStartAt is invalid');
    }
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < MIN_APPOINTMENT_DURATION_MINUTES ||
      durationMinutes > MAX_APPOINTMENT_DURATION_MINUTES
    ) {
      throw new BadRequestException(
        `durationMinutes must be an integer between ${MIN_APPOINTMENT_DURATION_MINUTES} and ${MAX_APPOINTMENT_DURATION_MINUTES}`,
      );
    }

    const minLeadMinutes = this.effectiveProposalMinLeadMinutes();
    await this.assertProposedIntervalEligible({
      astrologerId: profile.id,
      startAt: start,
      durationMinutes,
      occupied: params.occupied ?? [],
      now,
      minLeadMinutes,
    });
  }

  /**
   * Continuous-interval eligibility (no scheduling-grid alignment).
   * Used for proposals; public slot listing may still use enumerateSlots.
   */
  private async assertProposedIntervalEligible(params: {
    astrologerId: string;
    startAt: Date;
    durationMinutes: number;
    occupied: OccupiedInterval[];
    now: Date;
    minLeadMinutes: number;
  }): Promise<void> {
    const localStart = DateTime.fromJSDate(params.startAt, {
      zone: 'utc',
    }).setZone(BUSINESS_TIMEZONE);
    if (!localStart.isValid) {
      throw new BadRequestException('Start time is invalid');
    }

    const nowUtc = DateTime.fromJSDate(params.now, { zone: 'utc' });
    const startUtc = DateTime.fromJSDate(params.startAt, { zone: 'utc' });
    if (startUtc < nowUtc) {
      throw new BadRequestException('Proposed start time is in the past');
    }

    const leadCutoff = nowUtc.plus({ minutes: params.minLeadMinutes });
    if (startUtc < leadCutoff) {
      throw new BadRequestException(
        `Appointment must start at least ${params.minLeadMinutes} minutes from now`,
      );
    }

    const horizonEnd = nowInColombo(params.now)
      .startOf('day')
      .plus({ days: MAX_BOOKING_HORIZON_DAYS });
    if (localStart.startOf('day') > horizonEnd) {
      throw new BadRequestException(
        `Proposed date is beyond the ${MAX_BOOKING_HORIZON_DAYS}-day booking horizon`,
      );
    }

    const localEnd = localStart.plus({ minutes: params.durationMinutes });
    if (!localEnd.isValid || localEnd.toISODate() !== localStart.toISODate()) {
      throw new BadRequestException(
        'Proposed appointment must start and end on the same Asia/Colombo calendar day',
      );
    }

    const dateIso = localStart.toISODate();
    const [weekly, exceptions] = await Promise.all([
      this.prisma.weeklyAvailability.findMany({
        where: { astrologerId: params.astrologerId },
      }),
      this.prisma.availabilityException.findMany({
        where: { astrologerId: params.astrologerId },
      }),
    ]);

    const windows = this.calculator.resolveLocalWindowsForDate({
      dateIso,
      weekly,
      exceptions,
    });
    if (windows.length === 0) {
      throw new BadRequestException(
        'Astrologer has no availability on the proposed date',
      );
    }

    const startMinutes = timeToMinutes(localStart.toFormat('HH:mm'));
    const endMinutes = timeToMinutes(localEnd.toFormat('HH:mm'));
    const fits = windows.some((w) => {
      const wStart = timeToMinutes(w.startTime);
      const wEnd = timeToMinutes(w.endTime);
      return startMinutes >= wStart && endMinutes <= wEnd;
    });
    if (!fits) {
      throw new BadRequestException(
        'Proposed time is outside the astrologer availability for that day',
      );
    }

    const endAt = DateTime.fromJSDate(params.startAt, { zone: 'utc' })
      .plus({ minutes: params.durationMinutes })
      .toJSDate();
    const conflicts = params.occupied.some((occ) => {
      const occStart = DateTime.fromJSDate(occ.startAt, { zone: 'utc' }).minus({
        minutes: APPOINTMENT_BUFFER_MINUTES,
      });
      const occEnd = DateTime.fromJSDate(occ.endAt, { zone: 'utc' }).plus({
        minutes: APPOINTMENT_BUFFER_MINUTES,
      });
      return occStart.toJSDate() < endAt && occEnd.toJSDate() > params.startAt;
    });
    if (conflicts) {
      throw new BadRequestException(
        'Proposed time conflicts with an existing appointment or reservation',
      );
    }
  }

  private async requirePublicBookable(astrologerId: string) {
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { id: astrologerId },
      include: { user: true },
    });
    if (
      !profile ||
      profile.status !== AstrologerProfileStatus.ACTIVE ||
      profile.user.status !== UserStatus.ACTIVE
    ) {
      throw new NotFoundException('Astrologer not available');
    }
    return profile;
  }

  private validateExceptionPayload(
    type: AvailabilityExceptionType,
    startTime?: string | null,
    endTime?: string | null,
  ) {
    if (type === AvailabilityExceptionType.AVAILABLE_OVERRIDE) {
      if (!startTime || !endTime) {
        throw new BadRequestException(
          'AVAILABLE_OVERRIDE requires startTime and endTime',
        );
      }
      assertValidWindow(startTime, endTime);
    }
    if (type === AvailabilityExceptionType.UNAVAILABLE) {
      if (startTime || endTime) {
        throw new BadRequestException(
          'UNAVAILABLE must not include startTime/endTime',
        );
      }
    }
  }

  private async assertExceptionCompatible(
    astrologerId: string,
    date: Date,
    dto: CreateAvailabilityExceptionDto,
  ) {
    const existing = await this.prisma.availabilityException.findMany({
      where: { astrologerId, date },
    });

    if (dto.type === AvailabilityExceptionType.UNAVAILABLE) {
      if (existing.length > 0) {
        throw new BadRequestException(
          'Conflicting exception already exists for this date',
        );
      }
      return;
    }

    // AVAILABLE_OVERRIDE
    if (
      existing.some((e) => e.type === AvailabilityExceptionType.UNAVAILABLE)
    ) {
      throw new BadRequestException(
        'Date is marked UNAVAILABLE; remove it before adding overrides',
      );
    }
    await this.assertOverrideNoOverlap(
      astrologerId,
      date,
      dto.startTime!,
      dto.endTime!,
    );
  }

  private async assertOverrideNoOverlap(
    astrologerId: string,
    date: Date,
    startTime: string,
    endTime: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.availabilityException.findMany({
      where: {
        astrologerId,
        date,
        type: AvailabilityExceptionType.AVAILABLE_OVERRIDE,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    for (const row of existing) {
      if (
        row.startTime &&
        row.endTime &&
        this.calculator.weeklyWindowsOverlap(
          startTime,
          endTime,
          row.startTime,
          row.endTime,
        )
      ) {
        throw new BadRequestException(
          'AVAILABLE_OVERRIDE windows overlap on this date',
        );
      }
    }
  }

  private toScheduleView(
    weekly: WeeklyAvailability[],
    exceptions: AvailabilityException[],
  ) {
    const weeklyGrouped: Record<
      DayKey,
      Array<{ id: string; startTime: string; endTime: string }>
    > = {
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: [],
    };

    for (const w of weekly) {
      weeklyGrouped[dayEnumToKey(w.dayOfWeek)].push({
        id: w.id,
        startTime: w.startTime,
        endTime: w.endTime,
      });
    }

    return {
      timezone: BUSINESS_TIMEZONE,
      weekly: weeklyGrouped,
      exceptions: exceptions.map((e) => this.toExceptionView(e)),
    };
  }

  private toExceptionView(e: AvailabilityException) {
    return {
      id: e.id,
      date: dbDateToIso(e.date),
      type: e.type,
      startTime: e.startTime,
      endTime: e.endTime,
      reason: e.reason,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }
}

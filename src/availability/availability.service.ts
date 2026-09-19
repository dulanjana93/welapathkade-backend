import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityCalculator } from './availability.calculator';
import {
  BUSINESS_TIMEZONE,
  MAX_BOOKING_HORIZON_DAYS,
  MIN_BOOKING_LEAD_MINUTES,
} from './availability.constants';
import { BookingGuardService } from './booking-guard.service';
import {
  CreateAvailabilityExceptionDto,
  PutWeeklyAvailabilityDto,
  UpdateAvailabilityExceptionDto,
  WeeklyWindowInputDto,
} from './dto/availability.dto';
import {
  DAY_KEYS,
  assertNoOverlaps,
  assertValidWindow,
  colomboDateToDbDate,
  dayEnumToKey,
  dayKeyToEnum,
  dbDateToIso,
  type DayKey,
} from './availability.time';

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: AvailabilityCalculator,
    private readonly bookingGuard: BookingGuardService,
  ) {}

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
      const windows = (dto[key] ?? []) as WeeklyWindowInputDto[];
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
          type === AvailabilityExceptionType.AVAILABLE_OVERRIDE ? endTime : null,
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
    if (duration < 15 || duration > 240) {
      throw new BadRequestException('durationMinutes must be between 15 and 240');
    }

    const [weekly, exceptions] = await Promise.all([
      this.prisma.weeklyAvailability.findMany({
        where: { astrologerId: profile.id },
      }),
      this.prisma.availabilityException.findMany({
        where: { astrologerId: profile.id },
      }),
    ]);

    const slots = this.calculator.enumerateSlots({
      fromDateIso: query.from,
      toDateIso: query.to,
      durationMinutes: duration,
      weekly,
      exceptions,
      occupied: [], // Phase 4+ injects appointments/reservations
    });

    return {
      timezone: BUSINESS_TIMEZONE,
      minLeadMinutes: MIN_BOOKING_LEAD_MINUTES,
      maxHorizonDays: MAX_BOOKING_HORIZON_DAYS,
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
    const weeklyGrouped: Record<DayKey, Array<{ id: string; startTime: string; endTime: string }>> =
      {
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

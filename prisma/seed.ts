/**
 * Development seed for Phase 2 service catalog (+ optional demo astrologer).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register prisma/seed.ts
 */
import {
  AstrologerApplicationStatus,
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  DayOfWeek,
  PrismaClient,
  ServiceStatus,
  UserRole,
  UserStatus,
  Language,
} from '@prisma/client';
import { generateReferralCode } from '../src/common/crypto/hashing';

const prisma = new PrismaClient();

const SERVICES = [
  {
    code: 'HOROSCOPE_READING',
    nameSi: 'කේන්දර බැලීම',
    nameEn: 'Horoscope reading',
    descriptionSi: 'ජන්ම කේන්දරය පදනම් කරගත් විග්‍රහය',
    descriptionEn: 'Birth-chart based consultation',
    minPrice: '500.00',
    maxPrice: '5000.00',
  },
  {
    code: 'PORONDAM',
    nameSi: 'පොරන්දම් බැලීම',
    nameEn: 'Porondam matching',
    descriptionSi: 'විවාහ පොරන්දම් සංසන්දනය',
    descriptionEn: 'Marriage compatibility matching',
    minPrice: '1000.00',
    maxPrice: '8000.00',
  },
  {
    code: 'NEKATH',
    nameSi: 'නැකැත් බැලීම',
    nameEn: 'Nekath / auspicious timing',
    descriptionSi: 'ශුභ මූහුර්ත නැකත් තෝරා ගැනීම',
    descriptionEn: 'Selecting auspicious times (nekath)',
    minPrice: '500.00',
    maxPrice: '4000.00',
  },
] as const;

async function upsertService(
  data: (typeof SERVICES)[number],
): Promise<string> {
  const existing = await prisma.service.findUnique({
    where: { code: data.code },
  });
  if (existing) {
    await prisma.service.update({
      where: { id: existing.id },
      data: {
        nameSi: data.nameSi,
        nameEn: data.nameEn,
        descriptionSi: data.descriptionSi,
        descriptionEn: data.descriptionEn,
        minPrice: data.minPrice,
        maxPrice: data.maxPrice,
        status: ServiceStatus.ACTIVE,
      },
    });
    return existing.id;
  }

  const created = await prisma.service.create({
    data: {
      code: data.code,
      nameSi: data.nameSi,
      nameEn: data.nameEn,
      descriptionSi: data.descriptionSi,
      descriptionEn: data.descriptionEn,
      minPrice: data.minPrice,
      maxPrice: data.maxPrice,
      status: ServiceStatus.ACTIVE,
    },
  });
  return created.id;
}

async function ensureDevAstrologer(serviceIds: string[]) {
  const phone = '+94760000001';
  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone,
        name: 'Dev Astrologer',
        role: UserRole.ASTROLOGER,
        status: UserStatus.ACTIVE,
        language: Language.SI,
        referralCode: generateReferralCode(),
      },
    });
  }

  let profile = await prisma.astrologerProfile.findUnique({
    where: { userId: user.id },
  });
  if (!profile) {
    profile = await prisma.astrologerProfile.create({
      data: {
        userId: user.id,
        displayName: 'Dev Astrologer (seed)',
        bio: 'Development seed profile — not for production.',
        experienceYears: 5,
        city: 'Colombo',
        district: 'Colombo',
        status: AstrologerProfileStatus.ACTIVE,
      },
    });
  } else {
    profile = await prisma.astrologerProfile.update({
      where: { id: profile.id },
      data: {
        status: AstrologerProfileStatus.ACTIVE,
        city: profile.city ?? 'Colombo',
        district: profile.district ?? 'Colombo',
      },
    });
  }

  const existingApp = await prisma.astrologerApplication.findUnique({
    where: { astrologerProfileId: profile.id },
  });
  if (!existingApp) {
    await prisma.astrologerApplication.create({
      data: {
        astrologerProfileId: profile.id,
        status: AstrologerApplicationStatus.APPROVED,
        submittedAt: new Date(),
        reviewedAt: new Date(),
      },
    });
  } else {
    await prisma.astrologerApplication.update({
      where: { id: existingApp.id },
      data: {
        status: AstrologerApplicationStatus.APPROVED,
        rejectionReason: null,
        reviewedAt: existingApp.reviewedAt ?? new Date(),
        submittedAt: existingApp.submittedAt ?? new Date(),
      },
    });
  }

  for (const serviceId of serviceIds) {
    const existing = await prisma.astrologerService.findUnique({
      where: {
        astrologerId_serviceId: {
          astrologerId: profile.id,
          serviceId,
        },
      },
    });
    if (!existing) {
      await prisma.astrologerService.create({
        data: {
          astrologerId: profile.id,
          serviceId,
          price: '1500.00',
          status: AstrologerServiceStatus.ACTIVE,
        },
      });
    }
  }

  await prisma.astrologerBookingGuard.upsert({
    where: { astrologerId: profile.id },
    create: { astrologerId: profile.id },
    update: {},
  });

  const weeklyCount = await prisma.weeklyAvailability.count({
    where: { astrologerId: profile.id },
  });
  if (weeklyCount === 0) {
    const windows: Array<{ dayOfWeek: DayOfWeek; startTime: string; endTime: string }> = [
      { dayOfWeek: DayOfWeek.MONDAY, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: DayOfWeek.MONDAY, startTime: '14:00', endTime: '18:00' },
      { dayOfWeek: DayOfWeek.TUESDAY, startTime: '10:00', endTime: '17:00' },
      { dayOfWeek: DayOfWeek.WEDNESDAY, startTime: '09:00', endTime: '17:00' },
      { dayOfWeek: DayOfWeek.THURSDAY, startTime: '09:00', endTime: '17:00' },
      { dayOfWeek: DayOfWeek.FRIDAY, startTime: '09:00', endTime: '17:00' },
      { dayOfWeek: DayOfWeek.SATURDAY, startTime: '09:00', endTime: '13:00' },
    ];
    await prisma.weeklyAvailability.createMany({
      data: windows.map((w) => ({
        astrologerId: profile.id,
        dayOfWeek: w.dayOfWeek,
        startTime: w.startTime,
        endTime: w.endTime,
      })),
    });
  }

  return { userId: user.id, profileId: profile.id, phone };
}

async function main() {
  const serviceIds: string[] = [];
  for (const service of SERVICES) {
    serviceIds.push(await upsertService(service));
  }

  const astrologer = await ensureDevAstrologer(serviceIds);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        message: 'Phase 3 seed complete',
        services: SERVICES.map((s) => s.code),
        devAstrologer: astrologer,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

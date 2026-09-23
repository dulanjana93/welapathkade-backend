import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DateTime } from 'luxon';
import {
  AstrologerApplicationStatus,
  AstrologerProfileStatus,
  AvailabilityExceptionType,
  UserRole,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { assertTestDatabase } from '../src/common/database-safety/assert-test-database';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

describe('Phase 3 Availability (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let authService: AuthService;
  let tokenService: TokenService;
  let usersService: UsersService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    authService = app.get(AuthService);
    tokenService = app.get(TokenService);
    usersService = app.get(UsersService);
  });

  beforeEach(async () => {
    await resetE2eDatabase(prisma);
    await resetE2eRedisOtps(redis);
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerAstrologer(phone: string, name: string) {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone, purpose: 'ASTROLOGER_REGISTRATION' })
      .expect(201);
    const code = authService.getDevOtp(phone);
    if (!code) throw new Error('missing otp');
    return request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, code, name })
      .expect(201);
  }

  async function issueAdmin() {
    const admin = await usersService.createAdminUser({
      email: 'admin-phase3@welapathkade.test',
      password: 'AdminPass1!',
      phone: '+94773339999',
      name: 'Admin',
    });
    return tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
  }

  const sampleWeekly = {
    monday: [
      { startTime: '09:00', endTime: '12:00' },
      { startTime: '14:00', endTime: '18:00' },
    ],
    tuesday: [{ startTime: '10:00', endTime: '17:00' }],
    wednesday: [],
    thursday: [{ startTime: '09:00', endTime: '17:00' }],
    friday: [{ startTime: '09:00', endTime: '17:00' }],
    saturday: [],
    sunday: [],
  };

  it('astrologer can create/update weekly availability with multiple windows', async () => {
    const reg = await registerAstrologer('+94773330001', 'Astro A');
    const token = reg.body.accessToken as string;

    const created = await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleWeekly)
      .expect(200);

    expect(created.body.timezone).toBe('Asia/Colombo');
    expect(created.body.weekly.monday).toHaveLength(2);
    expect(created.body.weekly.tuesday).toHaveLength(1);
    expect(created.body.weekly.wednesday).toEqual([]);

    const updated = await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...sampleWeekly,
        monday: [{ startTime: '08:00', endTime: '11:00' }],
      })
      .expect(200);
    expect(updated.body.weekly.monday).toHaveLength(1);
    expect(updated.body.weekly.monday[0].startTime).toBe('08:00');
  });

  it('rejects overlapping, zero-length, and invalid times', async () => {
    const reg = await registerAstrologer('+94773330002', 'Astro B');
    const token = reg.body.accessToken as string;

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({
        monday: [
          { startTime: '09:00', endTime: '12:00' },
          { startTime: '11:00', endTime: '14:00' },
        ],
      })
      .expect(400);

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ monday: [{ startTime: '09:00', endTime: '09:00' }] })
      .expect(400);

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ monday: [{ startTime: '25:00', endTime: '26:00' }] })
      .expect(400);
  });

  it('astrologer cannot modify another astrologer availability', async () => {
    const a = await registerAstrologer('+94773330003', 'Astro C');
    const b = await registerAstrologer('+94773330004', 'Astro D');

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${a.body.accessToken}`)
      .send(sampleWeekly)
      .expect(200);

    const profileA = await prisma.astrologerProfile.findFirstOrThrow({
      where: { user: { phone: '+94773330003' } },
    });

    // B's PUT only touches B's schedule — A's windows remain.
    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${b.body.accessToken}`)
      .send({ friday: [{ startTime: '10:00', endTime: '12:00' }] })
      .expect(200);

    const aWindows = await prisma.weeklyAvailability.count({
      where: { astrologerId: profileA.id },
    });
    expect(aWindows).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .get('/astrologers/me/availability')
      .set('Authorization', `Bearer ${b.body.accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.weekly.monday).toEqual([]);
        expect(res.body.weekly.friday).toHaveLength(1);
      });
  });

  it('public can read ACTIVE availability only', async () => {
    const reg = await registerAstrologer('+94773330005', 'Astro E');
    const token = reg.body.accessToken as string;
    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleWeekly)
      .expect(200);

    const profile = await prisma.astrologerProfile.findFirstOrThrow({
      where: { user: { phone: '+94773330005' } },
    });

    await request(app.getHttpServer())
      .get(`/astrologers/${profile.id}/availability`)
      .expect(404);

    await prisma.astrologerProfile.update({
      where: { id: profile.id },
      data: { status: AstrologerProfileStatus.ACTIVE },
    });

    const publicRes = await request(app.getHttpServer())
      .get(`/astrologers/${profile.id}/availability`)
      .expect(200);
    expect(publicRes.body.timezone).toBe('Asia/Colombo');
    expect(publicRes.body.weekly.monday).toHaveLength(2);
    expect(publicRes.body).not.toHaveProperty('phone');
    expect(publicRes.body).not.toHaveProperty('referralCode');

    await prisma.astrologerProfile.update({
      where: { id: profile.id },
      data: { status: AstrologerProfileStatus.INACTIVE },
    });
    await request(app.getHttpServer())
      .get(`/astrologers/${profile.id}/availability`)
      .expect(404);

    await prisma.astrologerProfile.update({
      where: { id: profile.id },
      data: { status: AstrologerProfileStatus.SUSPENDED },
    });
    await request(app.getHttpServer())
      .get(`/astrologers/${profile.id}/availability`)
      .expect(404);
  });

  it('exceptions: UNAVAILABLE, AVAILABLE_OVERRIDE, conflicts', async () => {
    const reg = await registerAstrologer('+94773330006', 'Astro F');
    const token = reg.body.accessToken as string;
    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleWeekly)
      .expect(200);

    const profile = await prisma.astrologerProfile.findFirstOrThrow({
      where: { user: { phone: '+94773330006' } },
    });
    await prisma.astrologerProfile.update({
      where: { id: profile.id },
      data: { status: AstrologerProfileStatus.ACTIVE },
    });

    // Use near-future Colombo weekdays so lead/horizon rules don't wipe fixtures.
    const base = DateTime.now().setZone('Asia/Colombo').plus({ days: 3 }).startOf('day');
    // Find a Friday and following Saturday within horizon
    let friday = base;
    while (friday.weekday !== 5) {
      friday = friday.plus({ days: 1 });
    }
    const saturday = friday.plus({ days: 1 });
    const fridayIso = friday.toISODate()!;
    const saturdayIso = saturday.toISODate()!;

    assertTestDatabase();
    await prisma.availabilityException.deleteMany({
      where: { astrologerId: profile.id },
    });

    await request(app.getHttpServer())
      .post('/astrologers/me/availability/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: fridayIso,
        type: AvailabilityExceptionType.UNAVAILABLE,
        reason: 'Holiday',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/astrologers/me/availability/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: fridayIso,
        type: AvailabilityExceptionType.AVAILABLE_OVERRIDE,
        startTime: '14:00',
        endTime: '16:00',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/astrologers/me/availability/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: saturdayIso,
        type: AvailabilityExceptionType.AVAILABLE_OVERRIDE,
        startTime: '14:00',
        endTime: '18:00',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/astrologers/me/availability/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: saturdayIso,
        type: AvailabilityExceptionType.AVAILABLE_OVERRIDE,
        startTime: '17:00',
        endTime: '19:00',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/astrologers/me/availability/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: saturday.plus({ days: 1 }).toISODate()!,
        type: AvailabilityExceptionType.AVAILABLE_OVERRIDE,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/astrologers/me/availability/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: saturday.plus({ days: 2 }).toISODate()!,
        type: AvailabilityExceptionType.UNAVAILABLE,
        startTime: '09:00',
        endTime: '10:00',
      })
      .expect(400);

    const slots = await request(app.getHttpServer())
      .get(`/astrologers/${profile.id}/availability/slots`)
      .query({
        from: fridayIso,
        to: saturdayIso,
        durationMinutes: 30,
      })
      .expect(200);

    const dates = new Set(
      (slots.body.slots as Array<{ localDate: string }>).map((s) => s.localDate),
    );
    expect(dates.has(fridayIso)).toBe(false);
    expect(dates.has(saturdayIso)).toBe(true);
  });

  it('onboarding readiness and admin approve require availability', async () => {
    const adminTokens = await issueAdmin();
    const service = await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({
        code: 'HOROSCOPE_READING',
        nameSi: 'කේන්දර බැලීම',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const reg = await registerAstrologer('+94773330007', 'Astro G');
    const token = reg.body.accessToken as string;

    await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        displayName: 'Ready Almost',
        city: 'Colombo',
        district: 'Colombo',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ serviceId: service.body.id, price: 1500 })
      .expect(201);

    const onboarding = await request(app.getHttpServer())
      .get('/astrologers/me/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(onboarding.body.readiness.availabilityRequired).toBe(true);
    expect(onboarding.body.readiness.availabilityReady).toBe(false);
    expect(onboarding.body.readiness.canSubmit).toBe(false);
    expect(onboarding.body.readiness.errors).toEqual(
      expect.arrayContaining(['weekly availability is required']),
    );

    await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleWeekly)
      .expect(200);

    await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const profile = await prisma.astrologerProfile.findFirstOrThrow({
      where: { user: { phone: '+94773330007' } },
    });

    // Simulate missing availability after submit (admin must still reject approve)
    assertTestDatabase();
    await prisma.weeklyAvailability.deleteMany({
      where: { astrologerId: profile.id },
    });

    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profile.id}/application`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ action: 'APPROVE' })
      .expect(400);

    const appRow = await prisma.astrologerApplication.findUniqueOrThrow({
      where: { astrologerProfileId: profile.id },
    });
    expect(appRow.status).toBe(AstrologerApplicationStatus.PENDING_REVIEW);

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleWeekly)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profile.id}/application`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ action: 'APPROVE' })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/admin/astrologers/${profile.id}`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .expect(200);
    expect(detail.body.availability.timezone).toBe('Asia/Colombo');
    expect(detail.body.availability.weekly.monday.length).toBeGreaterThan(0);
  });

  it('public users cannot access astrologer availability management', async () => {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+94773330008', purpose: 'PUBLIC_REGISTRATION' })
      .expect(201);
    const code = authService.getDevOtp('+94773330008');
    const pub = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: '+94773330008',
        code,
        name: 'Public',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/astrologers/me/availability')
      .set('Authorization', `Bearer ${pub.body.accessToken}`)
      .expect(403);

    expect(UserRole.PUBLIC).toBe('PUBLIC');
  });
});

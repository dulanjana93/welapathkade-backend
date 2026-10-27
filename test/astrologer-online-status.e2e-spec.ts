import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DateTime } from 'luxon';
import { AstrologerProfileStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(90_000);

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
type AuthBody = { accessToken: string };
type IdBody = { id: string };
type OnlineBody = { id: string; isOnline: boolean };
type PublicBody = { id: string; isOnline: boolean };
type OwnBody = { id: string; isOnline: boolean };
type SlotsBody = { slots: Array<{ startAt: string; endAt: string }> };

describe('Astrologer online status (e2e)', () => {
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
    await app.get(NotificationService).flushPending();
    await resetE2eDatabase(prisma);
    await resetE2eRedisOtps(redis);
  });

  afterAll(async () => {
    await app.get(NotificationService).flushPending();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function register(
    phone: string,
    name: string,
    purpose: 'PUBLIC_REGISTRATION' | 'ASTROLOGER_REGISTRATION',
  ) {
    await http().post('/auth/otp/request').send({ phone, purpose }).expect(201);
    const code = authService.getDevOtp(phone);
    if (!code) throw new Error(`Missing OTP for ${phone}`);
    const res = await http()
      .post('/auth/otp/verify')
      .send({ phone, code, name })
      .expect(201);
    return bodyOf<AuthBody>(res).accessToken;
  }

  async function seedApprovedAstrologer(phone: string) {
    const adminUser = await usersService.createAdminUser({
      email: 'admin-online@welapathkade.test',
      password: 'AdminPass1!',
      phone: '+94770001111',
      name: 'Admin Online',
    });
    const adminSession = await tokenService.issueSession({
      user: adminUser,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
    const admin = adminSession.accessToken;

    const service = await http()
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        code: `ON_${Date.now()}`,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const astroToken = await register(phone, 'Online Astro', 'ASTROLOGER_REGISTRATION');
    await http()
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({
        displayName: 'Online Astro',
        bio: 'Experienced',
        experienceYears: 5,
        city: 'Colombo',
        district: 'Colombo',
      })
      .expect(200);
    await http()
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({ serviceId: bodyOf<IdBody>(service).id, price: 1500 })
      .expect(201);
    const window = [{ startTime: '09:00', endTime: '17:00' }];
    await http()
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({
        monday: window,
        tuesday: window,
        wednesday: window,
        thursday: window,
        friday: window,
        saturday: window,
        sunday: window,
      })
      .expect(200);
    await http()
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${astroToken}`)
      .expect(201);
    const profile = await prisma.astrologerProfile.findFirstOrThrow({
      where: { user: { phone } },
    });
    await http()
      .patch(`/admin/astrologers/${profile.id}/application`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ action: 'APPROVE' })
      .expect(200);
    expect(profile.isOnline).toBe(false);
    const refreshed = await prisma.astrologerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(refreshed.status).toBe(AstrologerProfileStatus.ACTIVE);
    expect(refreshed.isOnline).toBe(false);

    return {
      astroToken,
      profileId: profile.id,
      serviceId: bodyOf<IdBody>(service).id,
    };
  }

  it('defaults Offline; own toggle persists; public APIs reflect it; offline blocks new requests', async () => {
    const ctx = await seedApprovedAstrologer('+94772223301');
    const meOffline = bodyOf<OwnBody>(
      await http()
        .get('/astrologers/me')
        .set('Authorization', `Bearer ${ctx.astroToken}`)
        .expect(200),
    );
    expect(meOffline.isOnline).toBe(false);

    const publicOffline = bodyOf<PublicBody>(
      await http().get(`/astrologers/${ctx.profileId}`).expect(200),
    );
    expect(publicOffline.isOnline).toBe(false);

    const customerToken = await register(
      '+94772223302',
      'Cust Online',
      'PUBLIC_REGISTRATION',
    );
    const range = {
      from: DateTime.now()
        .setZone(BUSINESS_TIMEZONE)
        .plus({ days: 2 })
        .toISODate()!,
      to: DateTime.now()
        .setZone(BUSINESS_TIMEZONE)
        .plus({ days: 5 })
        .toISODate()!,
      durationMinutes: 30,
    };
    const slots = await http()
      .get(`/astrologers/${ctx.profileId}/availability/slots`)
      .query(range)
      .expect(200);
    const slot = bodyOf<SlotsBody>(slots).slots[0];
    expect(slot).toBeTruthy(); // Online status does not imply no slots

    await http()
      .post('/consultations')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        astrologerId: ctx.profileId,
        serviceId: ctx.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
      })
      .expect(400);

    const stranger = await register(
      '+94772223303',
      'Stranger',
      'PUBLIC_REGISTRATION',
    );
    await http()
      .patch('/astrologers/me/online-status')
      .set('Authorization', `Bearer ${stranger}`)
      .send({ isOnline: true })
      .expect(403);

    const toggled = bodyOf<OnlineBody>(
      await http()
        .patch('/astrologers/me/online-status')
        .set('Authorization', `Bearer ${ctx.astroToken}`)
        .send({ isOnline: true })
        .expect(200),
    );
    expect(toggled.isOnline).toBe(true);

    const meOnline = bodyOf<OwnBody>(
      await http()
        .get('/astrologers/me')
        .set('Authorization', `Bearer ${ctx.astroToken}`)
        .expect(200),
    );
    expect(meOnline.isOnline).toBe(true);
    const publicOnline = bodyOf<PublicBody>(
      await http().get(`/astrologers/${ctx.profileId}`).expect(200),
    );
    expect(publicOnline.isOnline).toBe(true);
    const list = bodyOf<PublicBody[]>(await http().get('/astrologers').expect(200));
    expect(list.find((a) => a.id === ctx.profileId)?.isOnline).toBe(true);

    await http()
      .post('/consultations')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        astrologerId: ctx.profileId,
        serviceId: ctx.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
      })
      .expect(201);

    await http()
      .patch('/astrologers/me/online-status')
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({ isOnline: false })
      .expect(200);
    const persisted = await prisma.astrologerProfile.findUniqueOrThrow({
      where: { id: ctx.profileId },
    });
    expect(persisted.isOnline).toBe(false);
  });
});

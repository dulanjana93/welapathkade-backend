import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AstrologerApplicationStatus,
  AstrologerProfileStatus,
  UserRole,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';

describe('Phase 2.5 Role registration & onboarding (e2e)', () => {
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
    await prisma.auditLog.deleteMany();
    await prisma.availabilityException.deleteMany();
    await prisma.weeklyAvailability.deleteMany();
    await prisma.astrologerBookingGuard.deleteMany();
    await prisma.astrologerApplication.deleteMany();
    await prisma.astrologerService.deleteMany();
    await prisma.astrologerProfile.deleteMany();
    await prisma.service.deleteMany();
    await prisma.userSession.deleteMany();
    await prisma.userDevice.deleteMany();
    await prisma.otpVerification.deleteMany();
    await prisma.user.deleteMany();

    const client = redis.getClient();
    const keys = await client.keys('otp:*');
    if (keys.length > 0) {
      await client.del(...keys);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  function readDevOtp(phone: string): string {
    const code = authService.getDevOtp(phone);
    if (!code) throw new Error(`Missing OTP for ${phone}`);
    return code;
  }

  async function clearOtpLimits(phone: string) {
    const client = redis.getClient();
    await client.del(`otp:cooldown:${phone}`, `otp:hour:${phone}`);
  }

  async function registerPublic(phone: string, name: string, referralCode?: string) {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone, purpose: 'PUBLIC_REGISTRATION' })
      .expect(201);
    const body: Record<string, string> = {
      phone,
      code: readDevOtp(phone),
      name,
    };
    if (referralCode) body.referralCode = referralCode;
    return request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send(body)
      .expect(201);
  }

  async function registerAstrologer(
    phone: string,
    name: string,
    referralCode?: string,
  ) {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone, purpose: 'ASTROLOGER_REGISTRATION' })
      .expect(201);
    const body: Record<string, string> = {
      phone,
      code: readDevOtp(phone),
      name,
    };
    if (referralCode) body.referralCode = referralCode;
    return request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send(body)
      .expect(201);
  }

  it('creates PUBLIC vs ASTROLOGER from OTP purpose and enriches /auth/me', async () => {
    const publicRes = await registerPublic('+94771220001', 'Public One');
    expect(publicRes.body.user.role).toBe(UserRole.PUBLIC);
    expect(publicRes.body.user.applicationStatus).toBeUndefined();

    const astroRes = await registerAstrologer('+94771220002', 'Astro One');
    expect(astroRes.body.user.role).toBe(UserRole.ASTROLOGER);
    expect(astroRes.body.user.profileStatus).toBe(
      AstrologerProfileStatus.INACTIVE,
    );
    expect(astroRes.body.user.applicationStatus).toBe(
      AstrologerApplicationStatus.DRAFT,
    );

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${astroRes.body.accessToken}`)
      .expect(200);
    expect(me.body.applicationStatus).toBe(AstrologerApplicationStatus.DRAFT);
  });

  it('rejects re-registration and supports login for both roles', async () => {
    await registerPublic('+94771220003', 'Public Two');
    await clearOtpLimits('+94771220003');

    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+94771220003', purpose: 'ASTROLOGER_REGISTRATION' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+94771220003', purpose: 'LOGIN' })
      .expect(201);
    const loginPublic = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: '+94771220003', code: readDevOtp('+94771220003') })
      .expect(201);
    expect(loginPublic.body.user.role).toBe(UserRole.PUBLIC);

    await registerAstrologer('+94771220004', 'Astro Two');
    await clearOtpLimits('+94771220004');
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+94771220004' })
      .expect(201);
    const loginAstro = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: '+94771220004', code: readDevOtp('+94771220004') })
      .expect(201);
    expect(loginAstro.body.user.role).toBe(UserRole.ASTROLOGER);
  });

  it('assigns immutable public referral on astrologer registration', async () => {
    const referrer = await registerPublic('+94771220005', 'Referrer');
    const code = referrer.body.user.referralCode as string;

    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+94771220006', purpose: 'ASTROLOGER_REGISTRATION' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: '+94771220006',
        code: readDevOtp('+94771220006'),
        name: 'Astro Ref',
        referralCode: 'NOPE',
      })
      .expect(400);

    await clearOtpLimits('+94771220006');
    const ok = await registerAstrologer('+94771220006', 'Astro Ref', code);
    expect(ok.body.user.referredByUserId).toBe(referrer.body.user.id);

    await clearOtpLimits('+94771220006');
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+94771220006', purpose: 'LOGIN' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: '+94771220006',
        code: readDevOtp('+94771220006'),
        referralCode: code,
      })
      .expect(400);
  });

  it('onboarding submit + admin approve/reject with audit', async () => {
    const admin = await usersService.createAdminUser({
      phone: '+94771220999',
      name: 'Admin',
    });
    const adminTokens = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });

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

    const astro = await registerAstrologer('+94771220007', 'Astro Submit');
    const token = astro.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        displayName: 'Guru Complete',
        city: 'Colombo',
        district: 'Colombo',
        experienceYears: 8,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ serviceId: service.body.id, price: 1500 })
      .expect(201);

    const incomplete = await request(app.getHttpServer())
      .get('/astrologers/me/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(incomplete.body.readiness.availabilityReady).toBe(false);
    expect(incomplete.body.readiness.canSubmit).toBe(false);

    await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({
        monday: [
          { startTime: '09:00', endTime: '12:00' },
          { startTime: '14:00', endTime: '18:00' },
        ],
        tuesday: [{ startTime: '10:00', endTime: '17:00' }],
        wednesday: [{ startTime: '09:00', endTime: '17:00' }],
        thursday: [{ startTime: '09:00', endTime: '17:00' }],
        friday: [{ startTime: '09:00', endTime: '17:00' }],
        saturday: [{ startTime: '09:00', endTime: '13:00' }],
        sunday: [],
      })
      .expect(200);

    const submitted = await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(submitted.body.status).toBe(AstrologerApplicationStatus.PENDING_REVIEW);

    const pending = await request(app.getHttpServer())
      .get('/admin/astrologers')
      .query({ applicationStatus: 'PENDING_REVIEW' })
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .expect(200);
    expect(pending.body).toHaveLength(1);
    const profileId = pending.body[0].id as string;

    await request(app.getHttpServer())
      .get(`/admin/astrologers/${profileId}`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .expect(200);

    // Reject first
    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profileId}/application`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ action: 'REJECT', rejectionReason: 'Incomplete bio details' })
      .expect(200);

    const rejectedMe = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(rejectedMe.body.applicationStatus).toBe(
      AstrologerApplicationStatus.REJECTED,
    );
    expect(rejectedMe.body.rejectionReason).toBe('Incomplete bio details');
    expect(rejectedMe.body.profileStatus).toBe(AstrologerProfileStatus.INACTIVE);

    await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ bio: 'Updated bio for resubmit' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profileId}/application`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ action: 'APPROVE' })
      .expect(200);

    const approvedMe = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(approvedMe.body.applicationStatus).toBe(
      AstrologerApplicationStatus.APPROVED,
    );
    expect(approvedMe.body.profileStatus).toBe(AstrologerProfileStatus.ACTIVE);

    const audits = await prisma.auditLog.findMany();
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.some((a) => a.action.includes('APPROVE'))).toBe(true);
    expect(audits.some((a) => a.action.includes('REJECT'))).toBe(true);

    // Role guards
    await request(app.getHttpServer())
      .get('/admin/astrologers')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    const publicUser = await registerPublic('+94771220008', 'Public Guard');
    await request(app.getHttpServer())
      .get('/astrologers/me/onboarding')
      .set('Authorization', `Bearer ${publicUser.body.accessToken}`)
      .expect(403);
  });
});

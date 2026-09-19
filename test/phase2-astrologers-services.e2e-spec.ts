import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  ServiceStatus,
  UserRole,
  UserStatus,
  Language,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { generateReferralCode } from '../src/common/crypto/hashing';

describe('Phase 2 Astrologers + Services (e2e)', () => {
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

  async function loginAs(phone: string, name = 'Tester') {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone })
      .expect(201);
    const code = authService.getDevOtp(phone);
    if (!code) throw new Error('missing otp');
    const res = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, code, name })
      .expect(201);
    return res.body as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; role: string };
    };
  }

  async function createAdmin() {
    return usersService.createAdminUser({
      phone: '+94771119999',
      name: 'Admin',
    });
  }

  async function issueTokensForUser(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return tokenService.issueSession({
      user,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
  }

  it('public lists active services only; admin creates/updates; duplicate code rejected', async () => {
    const admin = await createAdmin();
    const tokens = await issueTokensForUser(admin.id);

    await request(app.getHttpServer()).get('/services').expect(200).expect([]);

    const created = await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        code: 'HOROSCOPE_READING',
        nameSi: 'කේන්දර බැලීම',
        nameEn: 'Horoscope reading',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    expect(created.body.minPrice).toBe('500.00');
    expect(created.body.maxPrice).toBe('5000.00');

    await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        code: 'HOROSCOPE_READING',
        nameSi: 'dup',
        nameEn: 'dup',
        minPrice: 1,
        maxPrice: 2,
      })
      .expect(409);

    await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        code: 'BAD',
        nameSi: 'bad',
        nameEn: 'bad',
        minPrice: 100,
        maxPrice: 50,
      })
      .expect(400);

    const listed = await request(app.getHttpServer()).get('/services').expect(200);
    expect(listed.body).toHaveLength(1);

    await request(app.getHttpServer())
      .patch(`/admin/services/${created.body.id}`)
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ status: ServiceStatus.INACTIVE })
      .expect(200);

    await request(app.getHttpServer()).get('/services').expect(200).expect([]);
    await request(app.getHttpServer())
      .get(`/services/${created.body.id}`)
      .expect(404);
  });

  it('astrologer profile/services + public discovery + privacy', async () => {
    const admin = await createAdmin();
    const adminTokens = await issueTokensForUser(admin.id);

    const serviceRes = await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({
        code: 'PORONDAM',
        nameSi: 'පොරන්දම් බැලීම',
        nameEn: 'Porondam',
        descriptionSi: 'desc si',
        descriptionEn: 'desc en',
        minPrice: 1000,
        maxPrice: 8000,
      })
      .expect(201);
    const serviceId = serviceRes.body.id as string;

    const publicSession = await loginAs('+94771110010', 'Public User');
    await request(app.getHttpServer())
      .post('/astrologers/me')
      .set('Authorization', `Bearer ${publicSession.accessToken}`)
      .send({ displayName: 'Nope' })
      .expect(403);

    const astrologer = await usersService.createAstrologerUser({
      phone: '+94771110020',
      name: 'Astro User',
    });
    const astroTokens = await issueTokensForUser(astrologer.id);

    const profile = await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({
        displayName: 'Guru Nimal',
        bio: 'Experienced',
        experienceYears: 12,
        city: 'Kandy',
        district: 'Kandy',
      })
      .expect(200);

    expect(profile.body.status).toBe(AstrologerProfileStatus.INACTIVE);
    expect(profile.body.isDiscoverable).toBe(false);

    await request(app.getHttpServer())
      .get('/astrologers')
      .expect(200)
      .expect([]);

    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({ serviceId, price: 100 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({ serviceId, price: 9000 })
      .expect(400);

    const assigned = await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({ serviceId, price: 2500 })
      .expect(201);
    expect(assigned.body.price).toBe('2500.00');

    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({ serviceId, price: 2600 })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profile.body.id}`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ status: AstrologerProfileStatus.ACTIVE })
      .expect(200);

    const discovery = await request(app.getHttpServer())
      .get('/astrologers')
      .query({ serviceId, minPrice: 2000, maxPrice: 3000 })
      .expect(200);

    expect(discovery.body).toHaveLength(1);
    expect(discovery.body[0].displayName).toBe('Guru Nimal');
    expect(discovery.body[0]).not.toHaveProperty('phone');
    expect(discovery.body[0]).not.toHaveProperty('referralCode');
    expect(discovery.body[0]).not.toHaveProperty('referredByUserId');
    expect(JSON.stringify(discovery.body)).not.toContain('+9477');

    const detail = await request(app.getHttpServer())
      .get(`/astrologers/${profile.body.id}`)
      .expect(200);
    expect(detail.body.services[0].nameEn).toBe('Porondam');
    expect(detail.body.services[0].price).toBe('2500.00');

    await request(app.getHttpServer())
      .patch(`/astrologers/me/services/${serviceId}`)
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({ price: 3000 })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/astrologers/me/services/${serviceId}`)
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .expect(200);

    await request(app.getHttpServer()).get('/astrologers').expect(200).expect([]);

    // Reactivate assignment after soft delete
    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroTokens.accessToken}`)
      .send({ serviceId, price: 2800 })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/admin/services/${serviceId}`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ status: ServiceStatus.INACTIVE })
      .expect(200);

    await request(app.getHttpServer()).get('/astrologers').expect(200).expect([]);
  });

  it('suspended astrologer and astrologer without services are hidden', async () => {
    const admin = await createAdmin();
    const adminTokens = await issueTokensForUser(admin.id);
    const serviceRes = await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({
        code: 'NEKATH',
        nameSi: 'නැකැත් බැලීම',
        nameEn: 'Nekath',
        minPrice: 500,
        maxPrice: 4000,
      })
      .expect(201);

    const astrologer = await prisma.user.create({
      data: {
        phone: '+94771110030',
        name: 'Hidden',
        role: UserRole.ASTROLOGER,
        status: UserStatus.ACTIVE,
        language: Language.SI,
        referralCode: generateReferralCode(),
      },
    });
    const tokens = await issueTokensForUser(astrologer.id);
    const profile = await request(app.getHttpServer())
      .post('/astrologers/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ displayName: 'Hidden Guru' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profile.body.id}`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ status: AstrologerProfileStatus.ACTIVE })
      .expect(200);

    // no services yet
    await request(app.getHttpServer()).get('/astrologers').expect(200).expect([]);

    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ serviceId: serviceRes.body.id, price: 1000 })
      .expect(201);

    expect(
      (await request(app.getHttpServer()).get('/astrologers').expect(200)).body,
    ).toHaveLength(1);

    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profile.body.id}`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .send({ status: AstrologerProfileStatus.SUSPENDED })
      .expect(200);

    await request(app.getHttpServer()).get('/astrologers').expect(200).expect([]);
    await request(app.getHttpServer())
      .get(`/astrologers/${profile.body.id}`)
      .expect(404);
  });

  it('Phase 1 auth still works and health is up', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    const session = await loginAs('+94771110040', 'Regression User');
    expect(session.user.role).toBe(UserRole.PUBLIC);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
  });
});

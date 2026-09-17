import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { OtpStatus, UserRole, UserStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { AUTH_CONSTANTS } from '../src/common/auth/auth.constants';
import { hashOtpCode } from '../src/common/crypto/hashing';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let authService: AuthService;

  const phoneA = '+94771110001';
  const phoneB = '+94771110002';
  const phoneC = '+94771110003';
  const phoneD = '+94771110004';
  const phoneE = '+94771110005';
  const phoneF = '+94771110006';
  const phoneG = '+94771110007';

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
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    authService = app.get(AuthService);
  });

  beforeEach(async () => {
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

  async function requestOtp(phone: string) {
    return request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone })
      .expect(201);
  }

  function readDevOtp(phone: string): string {
    const code = authService.getDevOtp(phone);
    if (!code) {
      throw new Error(`Missing dev OTP for ${phone}`);
    }
    return code;
  }

  it('requests OTP without returning the code', async () => {
    const res = await requestOtp(phoneA);
    expect(res.body.message).toBe('OTP sent');
    expect(res.body.purpose).toBe('PUBLIC_REGISTRATION');
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('otp');
    expect(JSON.stringify(res.body)).not.toContain(readDevOtp(phoneA));
  });

  it('registers a new user on OTP verification', async () => {
    await requestOtp(phoneA);
    const code = readDevOtp(phoneA);

    const res = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneA, code, name: 'Nimal' })
      .expect(201);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.name).toBe('Nimal');
    expect(res.body.user.role).toBe(UserRole.PUBLIC);
    expect(res.body.user.phone).toBe(phoneA);
    expect(res.body.user.referralCode).toBeDefined();
    expect(res.body).not.toHaveProperty('code');
  });

  it('logs in an existing user', async () => {
    await requestOtp(phoneA);
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneA, code: readDevOtp(phoneA), name: 'Nimal' })
      .expect(201);

    const client = redis.getClient();
    await client.del(`otp:cooldown:${phoneA}`, `otp:hour:${phoneA}`);

    await requestOtp(phoneA);
    const res = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneA, code: readDevOtp(phoneA) })
      .expect(201);

    expect(res.body.user.phone).toBe(phoneA);
    expect(res.body.user.name).toBe('Nimal');
  });

  it('rejects invalid OTP', async () => {
    await requestOtp(phoneB);
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneB, code: '000000', name: 'Kamal' })
      .expect(400);
  });

  it('rejects expired OTP', async () => {
    await requestOtp(phoneC);
    const pending = await prisma.otpVerification.findFirst({
      where: { phone: phoneC, status: OtpStatus.PENDING },
    });
    expect(pending).toBeTruthy();

    await prisma.otpVerification.update({
      where: { id: pending!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: phoneC,
        code: readDevOtp(phoneC),
        name: 'Sunil',
      })
      .expect(400);
  });

  it('locks OTP after max invalid attempts', async () => {
    await requestOtp(phoneD);

    for (let i = 0; i < AUTH_CONSTANTS.OTP_MAX_ATTEMPTS; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/auth/otp/verify')
        .send({ phone: phoneD, code: '111111', name: 'Attempt' });
      expect([400, 429]).toContain(res.status);
    }

    const locked = await prisma.otpVerification.findFirst({
      where: { phone: phoneD },
      orderBy: { createdAt: 'desc' },
    });
    expect(locked?.status).toBe(OtpStatus.LOCKED);

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: phoneD,
        code: readDevOtp(phoneD),
        name: 'Attempt',
      })
      .expect(400);
  });

  it('rotates refresh tokens and rejects the old token', async () => {
    await requestOtp(phoneE);
    const login = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneE, code: readDevOtp(phoneE), name: 'Rotate' })
      .expect(201);

    const firstRefresh = login.body.refreshToken as string;

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(201);

    expect(rotated.body.refreshToken).toBeDefined();
    expect(rotated.body.refreshToken).not.toBe(firstRefresh);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(401);
  });

  it('rejects revoked refresh tokens', async () => {
    await requestOtp(phoneF);
    const login = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneF, code: readDevOtp(phoneF), name: 'Logout' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: login.body.refreshToken })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });

  it('applies referral code on registration and rejects invalid codes', async () => {
    await requestOtp(phoneA);
    const referrerRes = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneA, code: readDevOtp(phoneA), name: 'Referrer' })
      .expect(201);

    const referralCode = referrerRes.body.user.referralCode as string;

    const client = redis.getClient();
    await client.del(`otp:cooldown:${phoneB}`, `otp:hour:${phoneB}`);

    await requestOtp(phoneB);
    const referred = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: phoneB,
        code: readDevOtp(phoneB),
        name: 'Referred',
        referralCode,
      })
      .expect(201);

    expect(referred.body.user.referredByUserId).toBe(referrerRes.body.user.id);

    await client.del(`otp:cooldown:${phoneC}`, `otp:hour:${phoneC}`);
    await requestOtp(phoneC);
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: phoneC,
        code: readDevOtp(phoneC),
        name: 'BadRef',
        referralCode: 'NOPECODE',
      })
      .expect(400);
  });

  it('rejects self-referral', async () => {
    await requestOtp(phoneG);
    const created = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneG, code: readDevOtp(phoneG), name: 'Self' })
      .expect(201);

    // Existing user cannot attach/change referral ownership.
    const client = redis.getClient();
    await client.del(`otp:cooldown:${phoneG}`, `otp:hour:${phoneG}`);
    await requestOtp(phoneG);

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: phoneG,
        code: readDevOtp(phoneG),
        referralCode: created.body.user.referralCode,
      })
      .expect(400);
  });

  it('rejects suspended user authentication', async () => {
    await requestOtp(phoneA);
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: phoneA, code: readDevOtp(phoneA), name: 'Suspended' })
      .expect(201);

    await prisma.user.update({
      where: { phone: phoneA },
      data: { status: UserStatus.SUSPENDED },
    });

    const client = redis.getClient();
    await client.del(`otp:cooldown:${phoneA}`, `otp:hour:${phoneA}`);

    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: phoneA })
      .expect(400);
  });

  it('does not store plaintext OTP codes', async () => {
    await requestOtp(phoneA);
    const code = readDevOtp(phoneA);
    const row = await prisma.otpVerification.findFirst({
      where: { phone: phoneA },
      orderBy: { createdAt: 'desc' },
    });

    expect(row).toBeTruthy();
    expect(row!.codeHash).not.toBe(code);
    expect(row!.codeHash).toBe(
      hashOtpCode(code, phoneA, process.env.JWT_ACCESS_SECRET!),
    );
  });
});

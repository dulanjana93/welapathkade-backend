import { INestApplication, ValidationPipe } from '@nestjs/common';
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { Test, TestingModule } from '@nestjs/testing';
import {
  AstrologerProfileStatus,
  ConsultationStatus,
  FileStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

function png(): Buffer {
  const body = Buffer.alloc(16);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  return body;
}

function pdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
}

function m4a(): Buffer {
  const ftypPayload = Buffer.concat([
    Buffer.from('ftyp'),
    Buffer.from('M4A '),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('M4A '),
  ]);
  const ftypSize = Buffer.alloc(4);
  ftypSize.writeUInt32BE(ftypPayload.length + 4);
  const mvhd = Buffer.alloc(28);
  mvhd.write('mvhd', 0, 'ascii');
  mvhd.writeUInt32BE(1000, 16);
  mvhd.writeUInt32BE(2000, 20);
  return Buffer.concat([ftypSize, ftypPayload, mvhd]);
}

describe('Consultation attachments (e2e)', () => {
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

  function readDevOtp(phone: string): string {
    const code = authService.getDevOtp(phone);
    if (!code) throw new Error(`Missing OTP for ${phone}`);
    return code;
  }

  async function registerPublic(phone: string, name: string) {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone, purpose: 'PUBLIC_REGISTRATION' })
      .expect(201);
    return request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, code: readDevOtp(phone), name })
      .expect(201);
  }

  async function registerAstrologer(phone: string, name: string) {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone, purpose: 'ASTROLOGER_REGISTRATION' })
      .expect(201);
    return request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, code: readDevOtp(phone), name })
      .expect(201);
  }

  async function issueAdmin() {
    const admin = await usersService.createAdminUser({
      email: `admin-attachments-${Date.now()}@welapathkade.test`,
      password: 'AdminPass1!',
      phone: `+94779${String(Date.now()).slice(-6)}`,
      name: 'Admin',
    });
    return tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
  }

  async function seedBookableAstrologer(phone: string) {
    const admin = await issueAdmin();
    const serviceRes = await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        code: `HORO_${Date.now()}`,
        nameSi: 'කේන්දර බැලීම',
        nameEn: 'Horoscope Reading',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);
    const reg = await registerAstrologer(phone, 'Astro Bookable');
    const token = reg.body.accessToken as string;
    await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        displayName: 'Astro Bookable',
        bio: 'Experienced',
        experienceYears: 5,
        city: 'Colombo',
        district: 'Colombo',
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ serviceId: serviceRes.body.id, price: 1500 })
      .expect(201);
    const weekly: Record<
      string,
      Array<{ startTime: string; endTime: string }>
    > = {
      monday: [{ startTime: '09:00', endTime: '17:00' }],
      tuesday: [{ startTime: '09:00', endTime: '17:00' }],
      wednesday: [{ startTime: '09:00', endTime: '17:00' }],
      thursday: [{ startTime: '09:00', endTime: '17:00' }],
      friday: [{ startTime: '09:00', endTime: '17:00' }],
      saturday: [{ startTime: '09:00', endTime: '17:00' }],
      sunday: [{ startTime: '09:00', endTime: '17:00' }],
    };
    await request(app.getHttpServer())
      .put('/astrologers/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .send(weekly)
      .expect(200);
    await request(app.getHttpServer())
      .post('/astrologers/me/application/submit')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const profile = await prisma.astrologerProfile.findFirstOrThrow({
      where: { user: { phone } },
    });
    await request(app.getHttpServer())
      .patch(`/admin/astrologers/${profile.id}/application`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ action: 'APPROVE' })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/astrologers/me/online-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ isOnline: true })
      .expect(200);
    const refreshed = await prisma.astrologerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(refreshed.status).toBe(AstrologerProfileStatus.ACTIVE);
    return {
      token,
      profileId: profile.id,
      serviceId: serviceRes.body.id as string,
    };
  }

  async function pickFutureSlot(astrologerId: string) {
    const from = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 2 })
      .toISODate()!;
    const to = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 5 })
      .toISODate()!;
    const slots = await request(app.getHttpServer())
      .get(`/astrologers/${astrologerId}/availability/slots`)
      .query({ from, to, durationMinutes: 30 })
      .expect(200);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    return slots.body.slots[0] as { startAt: string; endAt: string };
  }

  it('uploads pdf, jpeg, png, and m4a, and rejects a bad signature', async () => {
    const customer = await registerPublic('+94774442001', 'Customer Files');
    const token = customer.body.accessToken as string;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await request(app.getHttpServer())
      .post('/consultations/attachments')
      .attach('file', png(), 'chart.png')
      .field('kind', 'IMAGE')
      .expect(401);

    const image = await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png(), 'chart.png')
      .field('kind', 'IMAGE')
      .expect(201);
    expect(image.body.kind).toBe('IMAGE');
    expect(image.body.mimeType).toBe('image/png');
    expect(image.body.objectKey).toBeUndefined();

    const photo = await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', jpeg, 'photo.jpg')
      .field('kind', 'IMAGE')
      .expect(201);
    expect(photo.body.mimeType).toBe('image/jpeg');

    const document = await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pdf(), 'chart.pdf')
      .field('kind', 'DOCUMENT')
      .expect(201);
    expect(document.body.mimeType).toBe('application/pdf');

    const voice = await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', m4a(), 'note.m4a')
      .field('kind', 'VOICE_NOTE')
      .expect(201);
    expect(voice.body.mimeType).toBe('audio/mp4');

    await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('hello'), 'notes.txt')
      .field('kind', 'DOCUMENT')
      .expect(400);

    const stored = await prisma.file.findUniqueOrThrow({
      where: { id: image.body.id as string },
    });
    expect(stored.uploadedByUserId).toBe(customer.body.user.id);
    expect(stored.status).toBe(FileStatus.AVAILABLE);
    expect(stored.objectKey.startsWith('consultations/unlinked/')).toBe(true);
  });

  it('links only the owner files and keeps them after decline and expiry', async () => {
    const astroA = await seedBookableAstrologer('+94774442011');
    const astroB = await seedBookableAstrologer('+94774442012');
    const slot = await pickFutureSlot(astroA.profileId);
    const customerA = await registerPublic('+94774442021', 'Customer A');
    const customerB = await registerPublic('+94774442022', 'Customer B');
    const tokenA = customerA.body.accessToken as string;
    const admin = await issueAdmin();

    const uploaded = await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', png(), 'chart.png')
      .field('kind', 'IMAGE')
      .expect(201);
    const fileId = uploaded.body.id as string;

    const created = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
        files: [{ fileId, type: 'IMAGE' }],
      })
      .expect(201);
    const consultationId = created.body.id as string;
    const attachmentId = created.body.files[0].id as string;
    expect(created.body.files[0].originalFilename).toBe('chart.png');
    expect(created.body.status).toBe(ConsultationStatus.PENDING);

    const contentPath = `/consultations/${consultationId}/attachments/${attachmentId}/content`;
    const downloaded = await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(downloaded.headers['content-type']).toContain('image/png');
    expect(downloaded.body.equals(png())).toBe(true);

    await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${customerB.body.accessToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${astroB.token}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);

    const slot2 = await pickFutureSlot(astroA.profileId);
    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot2.startAt,
        files: [{ fileId, type: 'IMAGE' }],
      })
      .expect(400);
    expect(await prisma.consultation.count()).toBe(1);

    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${consultationId}/decline`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .send({})
      .expect(201);
    const afterDecline = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    expect(afterDecline.status).toBe(FileStatus.AVAILABLE);
    expect(await prisma.consultationFile.count({ where: { fileId } })).toBe(1);
    await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        status: ConsultationStatus.PENDING,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await request(app.getHttpServer())
      .get(`/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const expired = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(expired.status).toBe(ConsultationStatus.EXPIRED);
    expect(await prisma.consultationFile.count({ where: { fileId } })).toBe(1);
    await request(app.getHttpServer())
      .get(contentPath)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(200);
  });

  async function uploadImage(token: string, name = 'chart.png') {
    const uploaded = await request(app.getHttpServer())
      .post('/consultations/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png(), name)
      .field('kind', 'IMAGE')
      .expect(201);
    return uploaded.body.id as string;
  }

  it('replays a lost create response without linking the file twice', async () => {
    const astro = await seedBookableAstrologer('+94774442101');
    const slot = await pickFutureSlot(astro.profileId);
    const customer = await registerPublic('+94774442111', 'Retry Customer');
    const token = customer.body.accessToken as string;
    const fileId = await uploadImage(token);
    const body = {
      astrologerId: astro.profileId,
      serviceId: astro.serviceId,
      preferredStartAt: slot.startAt,
      preferredEndAt: slot.endAt,
      message: 'Please focus on career',
      files: [{ fileId, type: 'IMAGE' }],
    };

    const first = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'retry-key-01')
      .send(body)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'retry-key-01')
      .send(body)
      .expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.files).toHaveLength(1);
    expect(await prisma.consultation.count()).toBe(1);
    expect(await prisma.consultationFile.count({ where: { fileId } })).toBe(1);

    const conflict = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'retry-key-01')
      .send({ ...body, message: 'A different request' })
      .expect(409);
    expect(conflict.body.message).toContain('different consultation request');
    expect(await prisma.consultation.count()).toBe(1);

    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'other-key-02')
      .send(body)
      .expect(400);
    expect(await prisma.consultation.count()).toBe(1);
    expect(await prisma.consultationFile.count({ where: { fileId } })).toBe(1);
  });

  it('creates one consultation when two requests share a key', async () => {
    const astro = await seedBookableAstrologer('+94774442102');
    const slot = await pickFutureSlot(astro.profileId);
    const customer = await registerPublic(
      '+94774442112',
      'Concurrent Customer',
    );
    const token = customer.body.accessToken as string;
    const fileId = await uploadImage(token, 'parallel.png');
    const body = {
      astrologerId: astro.profileId,
      serviceId: astro.serviceId,
      preferredStartAt: slot.startAt,
      preferredEndAt: slot.endAt,
      files: [{ fileId, type: 'IMAGE' }],
    };
    const send = () =>
      request(app.getHttpServer())
        .post('/consultations')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'parallel-key-1')
        .send(body);

    const [first, second] = await Promise.all([send(), send()]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe(second.body.id);
    expect(await prisma.consultation.count()).toBe(1);
    expect(await prisma.consultationFile.count({ where: { fileId } })).toBe(1);
  });

  it('lets two customers reuse a key string for their own requests', async () => {
    const astro = await seedBookableAstrologer('+94774442103');
    const slot = await pickFutureSlot(astro.profileId);
    const customerA = await registerPublic('+94774442113', 'Customer A Key');
    const customerB = await registerPublic('+94774442114', 'Customer B Key');
    const tokenA = customerA.body.accessToken as string;
    const tokenB = customerB.body.accessToken as string;
    const fileA = await uploadImage(tokenA, 'a.png');
    const fileB = await uploadImage(tokenB, 'b.png');
    const shared = {
      astrologerId: astro.profileId,
      serviceId: astro.serviceId,
      preferredStartAt: slot.startAt,
      preferredEndAt: slot.endAt,
    };

    const createdA = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', 'shared-key-01')
      .send({ ...shared, files: [{ fileId: fileA, type: 'IMAGE' }] })
      .expect(201);
    const createdB = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', 'shared-key-01')
      .send({ ...shared, files: [{ fileId: fileB, type: 'IMAGE' }] })
      .expect(201);

    expect(createdA.body.id).not.toBe(createdB.body.id);
    expect(await prisma.consultation.count()).toBe(2);

    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', 'other-key-03')
      .send({ ...shared, files: [{ fileId: fileA, type: 'IMAGE' }] })
      .expect(400);
    expect(
      await prisma.consultationFile.count({ where: { fileId: fileA } }),
    ).toBe(1);

    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', 'bad')
      .send({ ...shared, files: [{ fileId: fileA, type: 'IMAGE' }] })
      .expect(400);
    expect(await prisma.consultation.count()).toBe(2);
  });
});

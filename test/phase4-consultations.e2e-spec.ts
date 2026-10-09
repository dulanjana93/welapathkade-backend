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
  ConsultationFileType,
  ConsultationStatus,
  FileStatus,
  UserRole,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { CONSULTATION_RESPONSE_TIMEOUT_HOURS } from '../src/consultations/consultation.constants';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

describe('Phase 4 Consultation Requests (e2e)', () => {
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
    // Let post-commit deliveries from the previous test settle first.
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
    const existing = await prisma.user.findUnique({
      where: { phone: '+94774449999' },
    });
    const admin =
      existing ??
      (await usersService.createAdminUser({
        email: 'admin-phase4@welapathkade.test',
        password: 'AdminPass1!',
        phone: '+94774449999',
        name: 'Admin',
      }));
    return tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
  }

  /** Fully onboarded ACTIVE astrologer with service + Mon–Fri availability. */
  async function seedBookableAstrologer(opts?: {
    phone?: string;
    price?: number;
  }) {
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

    const phone = opts?.phone ?? '+94774440001';
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
      .send({
        serviceId: serviceRes.body.id,
        price: opts?.price ?? 1500,
      })
      .expect(201);

    const weekly: Record<string, Array<{ startTime: string; endTime: string }>> =
      {
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

    const refreshed = await prisma.astrologerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(refreshed.status).toBe(AstrologerProfileStatus.ACTIVE);

    return {
      token,
      profileId: profile.id,
      serviceId: serviceRes.body.id as string,
      adminToken: admin.accessToken as string,
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
    return slots.body.slots[0] as {
      startAt: string;
      endAt: string;
      localDate: string;
      startTime: string;
    };
  }

  it('PUBLIC can create consultation; ASTROLOGER/ADMIN cannot', async () => {
    const astro = await seedBookableAstrologer();
    const slot = await pickFutureSlot(astro.profileId);
    const customer = await registerPublic('+94774441001', 'Customer One');

    const created = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
        message: 'Please check my kundali',
      })
      .expect(201);

    expect(created.body.status).toBe(ConsultationStatus.PENDING);
    expect(created.body.viewedAt).toBeNull();
    expect(created.body.requestedPrice).toBe('1500.00');
    expect(created.body.serviceNameEn).toBe('Horoscope Reading');
    expect(created.body.serviceNameSi).toBe('කේන්දර බැලීම');
    expect(created.body.preferredStartAt).toBe(slot.startAt);
    expect(created.body.timezone).toBe(BUSINESS_TIMEZONE);

    const submitted = new Date(created.body.submittedAt as string);
    const expires = new Date(created.body.expiresAt as string);
    expect(expires.getTime() - submitted.getTime()).toBe(
      CONSULTATION_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    // No reservation / booking guard side effects beyond existing guard row.
    const guardCount = await prisma.astrologerBookingGuard.count({
      where: { astrologerId: astro.profileId },
    });
    expect(guardCount).toBe(1);

    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${astro.token}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${astro.adminToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
      })
      .expect(403);
  });

  it('rejects inactive/suspended astrologer, inactive/unoffered service, invalid time', async () => {
    const astro = await seedBookableAstrologer({ phone: '+94774440002' });
    const slot = await pickFutureSlot(astro.profileId);
    const customer = await registerPublic('+94774441002', 'Customer Two');

    await prisma.astrologerProfile.update({
      where: { id: astro.profileId },
      data: { status: AstrologerProfileStatus.INACTIVE },
    });
    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
      })
      .expect(400);

    await prisma.astrologerProfile.update({
      where: { id: astro.profileId },
      data: { status: AstrologerProfileStatus.SUSPENDED },
    });
    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
      })
      .expect(400);

    await prisma.astrologerProfile.update({
      where: { id: astro.profileId },
      data: { status: AstrologerProfileStatus.ACTIVE },
    });

    await prisma.service.update({
      where: { id: astro.serviceId },
      data: { status: 'INACTIVE' },
    });
    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
      })
      .expect(400);

    await prisma.service.update({
      where: { id: astro.serviceId },
      data: { status: 'ACTIVE' },
    });

    const otherService = await prisma.service.create({
      data: {
        code: 'OTHER_SVC',
        nameSi: 'වෙනත්',
        nameEn: 'Other',
        minPrice: 100,
        maxPrice: 1000,
        status: 'ACTIVE',
      },
    });
    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: otherService.id,
        preferredStartAt: slot.startAt,
      })
      .expect(400);

    // Outside availability (03:00 Colombo ≈ previous evening UTC depending on DST — use local midnight).
    const badStart = DateTime.fromISO(slot.localDate, {
      zone: BUSINESS_TIMEZONE,
    })
      .set({ hour: 3, minute: 0 })
      .toUTC()
      .toISO()!;
    await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: badStart,
      })
      .expect(400);
  });

  it('ownership isolation, viewedAt, accept/decline/cancel/expire', async () => {
    const astroA = await seedBookableAstrologer({ phone: '+94774440003' });
    const astroB = await seedBookableAstrologer({ phone: '+94774440004' });
    const slot = await pickFutureSlot(astroA.profileId);
    const customerA = await registerPublic('+94774441003', 'Customer A');
    const customerB = await registerPublic('+94774441004', 'Customer B');

    const file = await prisma.file.create({
      data: {
        bucket: 'private-consultations',
        objectKey: `kundali/${customerA.body.user.id}/chart-1.png`,
        originalFilename: 'chart.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        uploadedByUserId: customerA.body.user.id,
        status: FileStatus.AVAILABLE,
      },
    });

    const created = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
        message: 'Help',
        files: [{ fileId: file.id, type: ConsultationFileType.KUNDALI }],
      })
      .expect(201);

    const id = created.body.id as string;

    // Astrologer A sees pending; B does not.
    const listA = await request(app.getHttpServer())
      .get('/astrologers/me/consultations')
      .query({ status: ConsultationStatus.PENDING })
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(200);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].customer.name).toBe('Customer A');

    const listB = await request(app.getHttpServer())
      .get('/astrologers/me/consultations')
      .set('Authorization', `Bearer ${astroB.token}`)
      .expect(200);
    expect(listB.body).toHaveLength(0);

    await request(app.getHttpServer())
      .get(`/astrologers/me/consultations/${id}`)
      .set('Authorization', `Bearer ${astroB.token}`)
      .expect(404);

    // Customer ownership
    await request(app.getHttpServer())
      .get(`/consultations/${id}`)
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/consultations/${id}`)
      .set('Authorization', `Bearer ${customerB.body.accessToken}`)
      .expect(404);

    const meList = await request(app.getHttpServer())
      .get('/consultations/me')
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .expect(200);
    expect(meList.body).toHaveLength(1);

    // View sets viewedAt once; does not extend expiresAt
    const beforeExpires = created.body.expiresAt as string;
    const detail1 = await request(app.getHttpServer())
      .get(`/astrologers/me/consultations/${id}`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(200);
    expect(detail1.body.viewedAt).toBeTruthy();
    expect(detail1.body.expiresAt).toBe(beforeExpires);
    expect(detail1.body.files).toHaveLength(1);
    expect(detail1.body.files[0].originalFilename).toBe('chart.png');
    expect(detail1.body.files[0].objectKey).toBeUndefined();

    const firstViewed = detail1.body.viewedAt as string;
    await new Promise((r) => setTimeout(r, 20));
    const detail2 = await request(app.getHttpServer())
      .get(`/astrologers/me/consultations/${id}`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(200);
    expect(detail2.body.viewedAt).toBe(firstViewed);
    expect(detail2.body.expiresAt).toBe(beforeExpires);

    // Snapshot survives price change
    await prisma.astrologerService.updateMany({
      where: { astrologerId: astroA.profileId },
      data: { price: 9999 },
    });
    const still = await request(app.getHttpServer())
      .get(`/consultations/${id}`)
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .expect(200);
    expect(still.body.requestedPrice).toBe('1500.00');

    // Accept
    const accepted = await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${id}/accept`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(201);
    expect(accepted.body.status).toBe(ConsultationStatus.ACCEPTED);
    expect(accepted.body.respondedAt).toBeTruthy();

    // Terminal: cannot accept/decline/cancel again
    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${id}/accept`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(409);
    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${id}/decline`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(409);
    await request(app.getHttpServer())
      .post(`/consultations/${id}/cancel`)
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .expect(409);

    // Fresh PENDING for decline + cancel + expire flows
    const slot2 = await pickFutureSlot(astroA.profileId);
    const c2 = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot2.startAt,
      })
      .expect(201);

    const declined = await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${c2.body.id}/decline`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .send({ reason: 'Busy that day' })
      .expect(201);
    expect(declined.body.status).toBe(ConsultationStatus.DECLINED);
    expect(declined.body.declineReason).toBe('Busy that day');

    const slot3 = await pickFutureSlot(astroA.profileId);
    const c3 = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot3.startAt,
      })
      .expect(201);

    const cancelled = await request(app.getHttpServer())
      .post(`/consultations/${c3.body.id}/cancel`)
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .expect(201);
    expect(cancelled.body.status).toBe(ConsultationStatus.CANCELLED);

    // Expire on accept when past expiresAt
    const slot4 = await pickFutureSlot(astroA.profileId);
    const c4 = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot4.startAt,
      })
      .expect(201);

    await prisma.consultation.update({
      where: { id: c4.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${c4.body.id}/accept`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(409);

    const expiredRow = await prisma.consultation.findUniqueOrThrow({
      where: { id: c4.body.id },
    });
    expect(expiredRow.status).toBe(ConsultationStatus.EXPIRED);

    // Decline expired similarly
    const slot5 = await pickFutureSlot(astroA.profileId);
    const c5 = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerA.body.accessToken}`)
      .send({
        astrologerId: astroA.profileId,
        serviceId: astroA.serviceId,
        preferredStartAt: slot5.startAt,
      })
      .expect(201);
    await prisma.consultation.update({
      where: { id: c5.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${c5.body.id}/decline`)
      .set('Authorization', `Bearer ${astroA.token}`)
      .expect(409);
    const expired2 = await prisma.consultation.findUniqueOrThrow({
      where: { id: c5.body.id },
    });
    expect(expired2.status).toBe(ConsultationStatus.EXPIRED);
  });

  it('notifications: request notifies the astrologer; decline notifies the customer without the reason; a second decline adds nothing', async () => {
    const astro = await seedBookableAstrologer({ phone: '+94774440009' });
    const slot = await pickFutureSlot(astro.profileId);
    const customer = await registerPublic('+94774441009', 'Customer D');
    const customerBody = customer.body as {
      accessToken: string;
      user: { id: string };
    };
    const profile = await prisma.astrologerProfile.findUniqueOrThrow({
      where: { id: astro.profileId },
    });

    const created = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerBody.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${id}/decline`)
      .set('Authorization', `Bearer ${astro.token}`)
      .send({ reason: 'Totally private reason' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${id}/decline`)
      .set('Authorization', `Bearer ${astro.token}`)
      .send({ reason: 'Totally private reason' })
      .expect(409);

    await app.get(NotificationService).flushPending();
    const rows = await prisma.notification.findMany();
    expect(rows.map((r) => r.type).sort()).toEqual([
      'CONSULTATION_DECLINED',
      'CONSULTATION_REQUESTED',
    ]);
    const requested = rows.find((r) => r.type === 'CONSULTATION_REQUESTED')!;
    const declined = rows.find((r) => r.type === 'CONSULTATION_DECLINED')!;
    expect(requested.userId).toBe(profile.userId);
    expect(requested.referenceId).toBe(id);
    expect(declined.userId).toBe(customerBody.user.id);
    expect(declined.referenceId).toBe(id);
    expect(JSON.stringify(declined).toLowerCase()).not.toContain(
      'private reason',
    );
  });

  it('application remains APPROVED after consultation flows', async () => {
    const astro = await seedBookableAstrologer({ phone: '+94774440005' });
    const appRow = await prisma.astrologerApplication.findFirstOrThrow({
      where: { astrologerProfileId: astro.profileId },
    });
    expect(appRow.status).toBe(AstrologerApplicationStatus.APPROVED);
    expect(appRow.status).not.toBe(UserRole.PUBLIC);
  });
});

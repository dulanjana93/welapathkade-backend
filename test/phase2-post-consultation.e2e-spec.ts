import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DateTime } from 'luxon';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  ConsultationStatus,
} from '@prisma/client';
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
type IdBody = { id: string };
type AuthBody = { accessToken: string };
type SlotsBody = { slots: Array<{ startAt: string; endAt: string }> };
type CheckoutBody = {
  appointment: {
    id: string;
    payment: { latestAttempt: { merchantReference: string } };
  };
};
type DetailBody = {
  id: string;
  status: string;
  completedAt: string | null;
  astrologerSummary: string | null;
  followUp: {
    available: boolean;
    isOpen: boolean;
    expiresAt: string | null;
    customerMessagesSent: number;
    customerMessagesRemaining: number;
    canSend: boolean;
  } | null;
  actionability: {
    stage: string;
    canWriteSummary: boolean;
    canSendFollowUpMessage: boolean;
    canBookAgain: boolean;
  };
  appointment: { status: string } | null;
};
type MessageBody = {
  id: string;
  body: string;
  senderRole: string;
};
type BookAgainBody = {
  eligible: boolean;
  reason: string | null;
  sourceConsultationId: string;
  astrologerId: string | null;
  serviceId: string | null;
  requestedPrice: string | null;
};

describe('Phase 2 post-consultation (e2e)', () => {
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

  async function adminToken() {
    const admin = await usersService.createAdminUser({
      email: 'admin-phase2pc@welapathkade.test',
      password: 'AdminPass1!',
      phone: '+94776688881',
      name: 'Admin P2',
    });
    const session = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
    return session.accessToken;
  }

  async function completedConsultation(
    astroPhone: string,
    custPhone: string,
    completedAt = new Date(Date.now() - 60 * 60 * 1000),
  ) {
    const admin = await adminToken();
    const service = await http()
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        code: `PC_${Date.now()}_${astroPhone.slice(-4)}`,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const astroToken = await register(
      astroPhone,
      'Astro PC',
      'ASTROLOGER_REGISTRATION',
    );
    await http()
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({
        displayName: 'Astro PC',
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
      where: { user: { phone: astroPhone } },
    });
    await http()
      .patch(`/admin/astrologers/${profile.id}/application`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ action: 'APPROVE' })
      .expect(200);
    await http()
      .patch('/astrologers/me/online-status')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({ isOnline: true })
      .expect(200);
    expect(
      (
        await prisma.astrologerProfile.findUniqueOrThrow({
          where: { id: profile.id },
        })
      ).status,
    ).toBe(AstrologerProfileStatus.ACTIVE);

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
      .get(`/astrologers/${profile.id}/availability/slots`)
      .query(range)
      .expect(200);
    const slot = bodyOf<SlotsBody>(slots).slots[0];

    const customerToken = await register(
      custPhone,
      'PC Customer',
      'PUBLIC_REGISTRATION',
    );
    const created = await http()
      .post('/consultations')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        astrologerId: profile.id,
        serviceId: bodyOf<IdBody>(service).id,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
      })
      .expect(201);
    const consultationId = bodyOf<IdBody>(created).id;
    await http()
      .post(`/astrologers/me/consultations/${consultationId}/accept`)
      .set('Authorization', `Bearer ${astroToken}`)
      .expect(201);
    const proposal = await http()
      .post(`/astrologers/me/consultations/${consultationId}/proposals`)
      .set('Authorization', `Bearer ${astroToken}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(201);
    await http()
      .post(
        `/consultations/${consultationId}/proposals/${bodyOf<IdBody>(proposal).id}/accept`,
      )
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(201);
    const checkout = await http()
      .post(
        `/consultations/${consultationId}/proposals/${bodyOf<IdBody>(proposal).id}/checkout`,
      )
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(201);
    await http()
      .post('/payments/callbacks/mock')
      .send({
        merchantReference:
          bodyOf<CheckoutBody>(checkout).appointment.payment.latestAttempt
            .merchantReference,
        success: true,
        amount: '1500.00',
        currency: 'LKR',
      })
      .expect(201);

    const appointmentId = bodyOf<CheckoutBody>(checkout).appointment.id;
    const sessionStartedAt = new Date(completedAt.getTime() - 15 * 60_000);
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.COMPLETED,
        sessionStartedAt,
        sessionEndedAt: completedAt,
        actualDurationSeconds: 900,
      },
    });
    await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        status: ConsultationStatus.COMPLETED,
        completedAt,
      },
    });

    return {
      astroToken,
      customerToken,
      consultationId,
      appointmentId,
      profileId: profile.id,
      serviceId: bodyOf<IdBody>(service).id,
      completedAt,
    };
  }

  it('both participants read completed history; stranger cannot', async () => {
    const ctx = await completedConsultation('+94771110001', '+94771110002');
    const customer = await http()
      .get(`/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    const astrologer = await http()
      .get(`/astrologers/me/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .expect(200);

    const c = bodyOf<DetailBody>(customer);
    const a = bodyOf<DetailBody>(astrologer);
    expect(c.status).toBe('COMPLETED');
    expect(a.status).toBe('COMPLETED');
    expect(c.completedAt).toBe(ctx.completedAt.toISOString());
    expect(c.followUp?.available).toBe(true);
    expect(c.followUp?.isOpen).toBe(true);
    expect(c.actionability.canBookAgain).toBe(true);
    expect(a.actionability.canWriteSummary).toBe(true);
    expect(c.actionability.canWriteSummary).toBe(false);

    const strangerToken = await register(
      '+94771110003',
      'Stranger',
      'PUBLIC_REGISTRATION',
    );
    await http()
      .get(`/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .expect(404);
    await http()
      .get(`/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .expect(404);
  });

  it('astrologer summary write/read rules', async () => {
    const ctx = await completedConsultation('+94771110011', '+94771110012');
    await http()
      .put(`/astrologers/me/consultations/${ctx.consultationId}/summary`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({ summary: '  Focus on career this month.  ' })
      .expect(200);

    const customer = bodyOf<DetailBody>(
      await http()
        .get(`/consultations/${ctx.consultationId}`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .expect(200),
    );
    expect(customer.astrologerSummary).toBe('Focus on career this month.');

    // Customer cannot write summary (no PUBLIC route).
    await http()
      .put(`/astrologers/me/consultations/${ctx.consultationId}/summary`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ summary: 'hacked' })
      .expect(403);

    // Incomplete consultation cannot receive a summary.
    const confirmed = await completedConsultation(
      '+94771110013',
      '+94771110014',
    );
    await prisma.consultation.update({
      where: { id: confirmed.consultationId },
      data: { status: ConsultationStatus.ACCEPTED, completedAt: null },
    });
    await prisma.appointment.update({
      where: { id: confirmed.appointmentId },
      data: { status: AppointmentStatus.CONFIRMED },
    });
    await http()
      .put(`/astrologers/me/consultations/${confirmed.consultationId}/summary`)
      .set('Authorization', `Bearer ${confirmed.astroToken}`)
      .send({ summary: 'too early' })
      .expect(409);
  });

  it('follow-up messaging window, limit, concurrency, and read-after-expiry', async () => {
    const completedAt = new Date();
    completedAt.setUTCHours(completedAt.getUTCHours() - 1);
    const ctx = await completedConsultation(
      '+94771110021',
      '+94771110022',
      completedAt,
    );

    // Messaging unavailable before completion.
    const pending = await completedConsultation('+94771110023', '+94771110024');
    await prisma.consultation.update({
      where: { id: pending.consultationId },
      data: { status: ConsultationStatus.ACCEPTED, completedAt: null },
    });
    await prisma.appointment.update({
      where: { id: pending.appointmentId },
      data: { status: AppointmentStatus.CONFIRMED },
    });
    await http()
      .post(`/consultations/${pending.consultationId}/messages`)
      .set('Authorization', `Bearer ${pending.customerToken}`)
      .send({ body: 'early' })
      .expect(409);

    const detail = bodyOf<DetailBody>(
      await http()
        .get(`/consultations/${ctx.consultationId}`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .expect(200),
    );
    expect(detail.followUp?.isOpen).toBe(true);
    expect(detail.followUp?.expiresAt).toBe(
      new Date(completedAt.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    );

    for (let i = 1; i <= 5; i += 1) {
      await http()
        .post(`/consultations/${ctx.consultationId}/messages`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .send({ body: `customer ${i}` })
        .expect(201);
    }
    await http()
      .post(`/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ body: 'customer 6' })
      .expect(409);

    // Failed validation does not consume allowance.
    const before = await prisma.consultationFollowUpMessage.count({
      where: {
        consultationId: ctx.consultationId,
        senderUserId: (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: ctx.consultationId },
          })
        ).customerId,
      },
    });
    expect(before).toBe(5);
    await http()
      .post(`/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ body: '' })
      .expect(400);
    await http()
      .post(`/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ body: 'x', attachmentUrl: 'https://evil.example/a.png' })
      .expect(400);

    // Astrologer replies are unlimited by the customer cap.
    await http()
      .post(`/astrologers/me/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({ body: 'astro reply' })
      .expect(201);

    // Concurrent customer sends on a fresh consultation cannot exceed 5.
    const concurrent = await completedConsultation(
      '+94771110025',
      '+94771110026',
      new Date(),
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        http()
          .post(`/consultations/${concurrent.consultationId}/messages`)
          .set('Authorization', `Bearer ${concurrent.customerToken}`)
          .send({ body: `race ${i}` }),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    const conflicted = results.filter((r) => r.status === 409).length;
    expect(created).toBe(5);
    expect(conflicted).toBe(3);
    expect(
      await prisma.consultationFollowUpMessage.count({
        where: {
          consultationId: concurrent.consultationId,
          senderUserId: (
            await prisma.consultation.findUniqueOrThrow({
              where: { id: concurrent.consultationId },
            })
          ).customerId,
        },
      }),
    ).toBe(5);

    // After expiry: cannot send, can still read.
    await prisma.consultation.update({
      where: { id: ctx.consultationId },
      data: {
        completedAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      },
    });
    await http()
      .post(`/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ body: 'late customer' })
      .expect(409);
    await http()
      .post(`/astrologers/me/consultations/${ctx.consultationId}/messages`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({ body: 'late astro' })
      .expect(409);

    const history = bodyOf<MessageBody[]>(
      await http()
        .get(`/consultations/${ctx.consultationId}/messages`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .expect(200),
    );
    expect(history.length).toBeGreaterThanOrEqual(6);
    expect(history.some((m) => m.body === 'astro reply')).toBe(true);
  });

  it('book again creates a new consultation without mutating the original', async () => {
    const ctx = await completedConsultation('+94771110031', '+94771110032');
    const preview = bodyOf<BookAgainBody>(
      await http()
        .get(`/consultations/${ctx.consultationId}/book-again`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .expect(200),
    );
    expect(preview.eligible).toBe(true);
    expect(preview.astrologerId).toBe(ctx.profileId);
    expect(preview.serviceId).toBe(ctx.serviceId);
    expect(preview.requestedPrice).toBe('1500.00');

    const range = {
      from: DateTime.now()
        .setZone(BUSINESS_TIMEZONE)
        .plus({ days: 6 })
        .toISODate()!,
      to: DateTime.now()
        .setZone(BUSINESS_TIMEZONE)
        .plus({ days: 9 })
        .toISODate()!,
      durationMinutes: 30,
    };
    const slots = await http()
      .get(`/astrologers/${ctx.profileId}/availability/slots`)
      .query(range)
      .expect(200);
    const slot = bodyOf<SlotsBody>(slots).slots[0];

    const created = await http()
      .post('/consultations')
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({
        astrologerId: preview.astrologerId,
        serviceId: preview.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
        message: 'Book again please',
      })
      .expect(201);
    const newId = bodyOf<IdBody>(created).id;
    expect(newId).not.toBe(ctx.consultationId);

    const original = await prisma.consultation.findUniqueOrThrow({
      where: { id: ctx.consultationId },
    });
    expect(original.status).toBe(ConsultationStatus.COMPLETED);
    expect(original.completedAt?.toISOString()).toBe(
      ctx.completedAt.toISOString(),
    );

    const neu = await prisma.consultation.findUniqueOrThrow({
      where: { id: newId },
    });
    expect(neu.status).toBe(ConsultationStatus.PENDING);
    expect(neu.completedAt).toBeNull();
    expect(neu.message).toBe('Book again please');
  });
});

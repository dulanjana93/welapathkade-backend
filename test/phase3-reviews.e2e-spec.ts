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
  myReview: { rating: number; body: string | null } | null;
  actionability: {
    canSubmitReview: boolean;
    canEditReview: boolean;
  };
};
type ReviewBody = { id: string; rating: number; body: string | null };
type PublicListBody = {
  items: Array<{
    id: string;
    rating: number;
    body: string | null;
    authorLabel: string;
    createdAt: string;
  }>;
  total: number;
  summary: { averageRating: number | null; reviewCount: number };
};
type PublicAstrologerBody = {
  id: string;
  ratingSummary: { averageRating: number | null; reviewCount: number };
};

describe('Phase 3 consultation reviews (e2e)', () => {
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
      email: 'admin-phase3rev@welapathkade.test',
      password: 'AdminPass1!',
      phone: '+94776677771',
      name: 'Admin P3',
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
    customerName = 'PC Customer',
  ) {
    const admin = await adminToken();
    const service = await http()
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        code: `RV_${Date.now()}_${astroPhone.slice(-4)}`,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const astroToken = await register(
      astroPhone,
      'Astro RV',
      'ASTROLOGER_REGISTRATION',
    );
    await http()
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({
        displayName: 'Astro RV',
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
      customerName,
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
    const completedAt = new Date();
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.COMPLETED,
        sessionStartedAt: new Date(completedAt.getTime() - 900_000),
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
    };
  }

  it('eligible customer can submit/edit; strangers and astrologer cannot', async () => {
    const ctx = await completedConsultation('+94772220001', '+94772220002', 'Nimal Perera');

    const detail = bodyOf<DetailBody>(
      await http()
        .get(`/consultations/${ctx.consultationId}`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .expect(200),
    );
    expect(detail.actionability.canSubmitReview).toBe(true);
    expect(detail.myReview).toBeNull();

    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ rating: 0 })
      .expect(400);
    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ rating: 6 })
      .expect(400);
    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ rating: 5, body: 'x'.repeat(1001) })
      .expect(400);

    const created = bodyOf<ReviewBody>(
      await http()
        .post(`/consultations/${ctx.consultationId}/review`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .send({ rating: 5, body: '  Excellent reading  ' })
        .expect(201),
    );
    expect(created.rating).toBe(5);
    expect(created.body).toBe('Excellent reading');

    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ rating: 4 })
      .expect(409);

    const updated = bodyOf<ReviewBody>(
      await http()
        .patch(`/consultations/${ctx.consultationId}/review`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .send({ rating: 4, body: '' })
        .expect(200),
    );
    expect(updated.rating).toBe(4);
    expect(updated.body).toBeNull();

    const stranger = await register(
      '+94772220003',
      'Stranger',
      'PUBLIC_REGISTRATION',
    );
    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${stranger}`)
      .send({ rating: 1 })
      .expect(404);
    await http()
      .patch(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${stranger}`)
      .send({ rating: 1 })
      .expect(404);
    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({ rating: 5 })
      .expect(403);

    const publicList = bodyOf<PublicListBody>(
      await http().get(`/astrologers/${ctx.profileId}/reviews`).expect(200),
    );
    expect(publicList.total).toBe(1);
    expect(publicList.summary.reviewCount).toBe(1);
    expect(publicList.summary.averageRating).toBe(4);
    expect(publicList.items[0].authorLabel).toBe('Nimal');
    expect(JSON.stringify(publicList)).not.toMatch(/customerId|phone|\+94/i);

    const card = bodyOf<PublicAstrologerBody>(
      await http().get(`/astrologers/${ctx.profileId}`).expect(200),
    );
    expect(card.ratingSummary).toEqual({
      averageRating: 4,
      reviewCount: 1,
    });
  });

  it('rejects ineligible consultations and excludes refunded reviews from aggregates', async () => {
    const ctx = await completedConsultation('+94772220011', '+94772220012');
    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: {
        status: AppointmentStatus.NO_SHOW_ASTROLOGER,
        refundObligation: 'FULL_REFUND_DUE',
      },
    });
    await prisma.consultation.update({
      where: { id: ctx.consultationId },
      data: { status: ConsultationStatus.CANCELLED, completedAt: null },
    });
    await http()
      .post(`/consultations/${ctx.consultationId}/review`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ rating: 1 })
      .expect(409);

    const ok = await completedConsultation('+94772220013', '+94772220014');
    await http()
      .post(`/consultations/${ok.consultationId}/review`)
      .set('Authorization', `Bearer ${ok.customerToken}`)
      .send({ rating: 5 })
      .expect(201);

    // Simulate a later refund obligation — review row remains but is excluded.
    await prisma.appointment.update({
      where: { id: ok.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    const list = bodyOf<PublicListBody>(
      await http().get(`/astrologers/${ok.profileId}/reviews`).expect(200),
    );
    expect(list.total).toBe(0);
    expect(list.summary).toEqual({ averageRating: null, reviewCount: 0 });
  });

  it('concurrent duplicate creates cannot insert two reviews', async () => {
    const ctx = await completedConsultation('+94772220021', '+94772220022');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http()
          .post(`/consultations/${ctx.consultationId}/review`)
          .set('Authorization', `Bearer ${ctx.customerToken}`)
          .send({ rating: 3, body: 'race' }),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    const conflicted = results.filter((r) => r.status === 409).length;
    expect(created).toBe(1);
    expect(conflicted).toBe(4);
    expect(
      await prisma.consultationReview.count({
        where: { consultationId: ctx.consultationId },
      }),
    ).toBe(1);
  });

  it('zero reviews show null average on discovery cards', async () => {
    const ctx = await completedConsultation('+94772220031', '+94772220032');
    const card = bodyOf<PublicAstrologerBody>(
      await http().get(`/astrologers/${ctx.profileId}`).expect(200),
    );
    expect(card.ratingSummary).toEqual({
      averageRating: null,
      reviewCount: 0,
    });
  });
});

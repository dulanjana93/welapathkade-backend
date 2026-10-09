import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DateTime } from 'luxon';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  ConsultationStatus,
  PaymentStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { NotificationService } from '../src/notifications/notification.service';
import { renderNotificationText } from '../src/notifications/notification.templates';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(90_000);

describe('Phase 5B payments (e2e)', () => {
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
      where: { phone: '+94776669999' },
    });
    const admin =
      existing ??
      (await usersService.createAdminUser({
        email: 'admin-phase5b@welapathkade.test',
        password: 'AdminPass1!',
        phone: '+94776669999',
        name: 'Admin 5B',
      }));
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
        code: `PAY_${Date.now()}_${phone.slice(-4)}`,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const reg = await registerAstrologer(phone, 'Astro Pay');
    const token = reg.body.accessToken as string;

    await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        displayName: 'Astro Pay',
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
    };
  }

  async function acceptedProposal(opts: {
    astroPhone: string;
    customerPhone: string;
    slotIndex?: number;
  }) {
    const astro = await seedBookableAstrologer(opts.astroPhone);
    const from = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 2 })
      .toISODate()!;
    const to = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 5 })
      .toISODate()!;
    const slots = await request(app.getHttpServer())
      .get(`/astrologers/${astro.profileId}/availability/slots`)
      .query({ from, to, durationMinutes: 30 })
      .expect(200);
    const slot = slots.body.slots[opts.slotIndex ?? 0] as {
      startAt: string;
      endAt: string;
    };

    const customer = await registerPublic(opts.customerPhone, 'Pay Customer');
    const created = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .send({
        astrologerId: astro.profileId,
        serviceId: astro.serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${created.body.id}/accept`)
      .set('Authorization', `Bearer ${astro.token}`)
      .expect(201);

    const proposal = await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${created.body.id}/proposals`)
      .set('Authorization', `Bearer ${astro.token}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(201);

    await request(app.getHttpServer())
      .post(
        `/consultations/${created.body.id}/proposals/${proposal.body.id}/accept`,
      )
      .set('Authorization', `Bearer ${customer.body.accessToken}`)
      .expect(201);

    return {
      astro,
      customerToken: customer.body.accessToken as string,
      consultationId: created.body.id as string,
      proposalId: proposal.body.id as string,
      slot,
    };
  }

  it('checkout + mock notify confirms appointment; duplicate notify is a no-op', async () => {
    const ctx = await acceptedProposal({
      astroPhone: '+94776660001',
      customerPhone: '+94776661001',
    });

    const checkout = await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);

    expect(checkout.body.appointment.status).toBe(
      AppointmentStatus.PAYMENT_PENDING,
    );
    expect(checkout.body.appointment.amount).toBe('1500.00');
    expect(checkout.body.checkout.mock).toBe(true);
    expect(
      checkout.body.appointment.payment.latestAttempt.merchantReference,
    ).toBeTruthy();

    const again = await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    expect(again.body.appointment.id).toBe(checkout.body.appointment.id);
    expect(await prisma.appointment.count()).toBe(1);

    const merchantReference =
      checkout.body.appointment.payment.latestAttempt.merchantReference;

    const paid = await request(app.getHttpServer())
      .post('/payments/callbacks/mock')
      .send({
        merchantReference,
        success: true,
        amount: '1500.00',
        currency: 'LKR',
      })
      .expect(201);
    expect(paid.body.appointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(paid.body.appointment.payment.status).toBe(PaymentStatus.PAID);

    const replay = await request(app.getHttpServer())
      .post('/payments/callbacks/mock')
      .send({
        merchantReference,
        success: true,
        amount: '1500.00',
        currency: 'LKR',
      })
      .expect(201);
    expect(replay.body.alreadyPaid).toBe(true);
    expect(await prisma.appointment.count()).toBe(1);
    expect(
      await prisma.payment.count({ where: { status: PaymentStatus.PAID } }),
    ).toBe(1);

    const fetched = await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}/appointment`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(fetched.body.status).toBe(AppointmentStatus.CONFIRMED);

    const detail = await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(detail.body.status).toBe(ConsultationStatus.ACCEPTED);
    expect(detail.body.appointment.status).toBe(AppointmentStatus.CONFIRMED);

    const synced = await request(app.getHttpServer())
      .post(`/consultations/${ctx.consultationId}/appointment/sync`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    expect(synced.body.status).toBe(AppointmentStatus.CONFIRMED);
  });

  it('notifications: one row per event and recipient across the full lifecycle; callback replays and sync add none', async () => {
    const ctx = await acceptedProposal({
      astroPhone: '+94776660002',
      customerPhone: '+94776661002',
    });
    const astroProfile = await prisma.astrologerProfile.findUniqueOrThrow({
      where: { id: ctx.astro.profileId },
      include: { user: true },
    });
    const customerUser = await prisma.user.findFirstOrThrow({
      where: { phone: '+94776661002' },
    });

    const checkout = await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    const checkoutBody = checkout.body as {
      appointment: {
        id: string;
        payment: { latestAttempt: { merchantReference: string } };
      };
    };
    const appointmentId = checkoutBody.appointment.id;
    const merchantReference =
      checkoutBody.appointment.payment.latestAttempt.merchantReference;

    const notifications = app.get(NotificationService);
    await notifications.flushPending();
    // Before payment there is no APPOINTMENT_CONFIRMED.
    expect(
      await prisma.notification.count({
        where: { type: 'APPOINTMENT_CONFIRMED' },
      }),
    ).toBe(0);

    const pay = () =>
      request(app.getHttpServer())
        .post('/payments/callbacks/mock')
        .send({
          merchantReference,
          success: true,
          amount: '1500.00',
          currency: 'LKR',
        })
        .expect(201);
    await pay();
    await pay(); // repeated callback
    await request(app.getHttpServer())
      .post(`/consultations/${ctx.consultationId}/appointment/sync`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    await notifications.flushPending();

    const rows = await prisma.notification.findMany();
    const who = (userId: string) =>
      userId === astroProfile.userId
        ? 'astrologer'
        : userId === customerUser.id
          ? 'customer'
          : 'unexpected';
    expect(
      rows.map((r) => `${r.type}|${who(r.userId)}|${r.referenceId}`).sort(),
    ).toEqual(
      [
        `CONSULTATION_REQUESTED|astrologer|${ctx.consultationId}`,
        `CONSULTATION_ACCEPTED|customer|${ctx.consultationId}`,
        `PROPOSAL_CREATED|customer|${ctx.proposalId}`,
        `PROPOSAL_ACCEPTED|astrologer|${ctx.proposalId}`,
        `APPOINTMENT_CONFIRMED|customer|${appointmentId}`,
        `APPOINTMENT_CONFIRMED|astrologer|${appointmentId}`,
      ].sort(),
    );

    for (const row of rows) {
      const recipient =
        row.userId === astroProfile.userId ? astroProfile.user : customerUser;
      const text = renderNotificationText(row.type, recipient.language);
      expect(row.title).toBe(text.title);
      expect(row.body).toBe(text.body);
      expect(row.data).toMatchObject({
        type: row.type,
        consultationId: ctx.consultationId,
      });
      // No provider accepted anything (no-op provider, no devices).
      expect(row.sentAt).toBeNull();
      expect(row.attempts).toBe(0);
    }
    const accepted = rows.find((r) => r.type === 'PROPOSAL_ACCEPTED');
    expect(accepted?.body).toMatch(/pending|තවමත්/);
  });

  it('amount mismatch does not confirm', async () => {
    const ctx = await acceptedProposal({
      astroPhone: '+94776660002',
      customerPhone: '+94776661002',
    });
    const checkout = await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    const merchantReference =
      checkout.body.appointment.payment.latestAttempt.merchantReference;

    await request(app.getHttpServer())
      .post('/payments/callbacks/mock')
      .send({
        merchantReference,
        success: true,
        amount: '1.00',
        currency: 'LKR',
      })
      .expect(409);

    const row = await prisma.appointment.findFirstOrThrow({
      where: { consultationId: ctx.consultationId },
    });
    expect(row.status).toBe(AppointmentStatus.PAYMENT_PENDING);
    await app.get(NotificationService).flushPending();
    expect(
      await prisma.notification.count({
        where: { type: 'APPOINTMENT_CONFIRMED' },
      }),
    ).toBe(0);
  });

  it('expired reservation does not confirm late payment', async () => {
    const ctx = await acceptedProposal({
      astroPhone: '+94776660003',
      customerPhone: '+94776661003',
    });
    const checkout = await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    const merchantReference =
      checkout.body.appointment.payment.latestAttempt.merchantReference;

    await prisma.appointment.update({
      where: { id: checkout.body.appointment.id },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });

    await request(app.getHttpServer())
      .post('/payments/callbacks/mock')
      .send({
        merchantReference,
        success: true,
        amount: '1500.00',
        currency: 'LKR',
      })
      .expect(409);

    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: checkout.body.appointment.id },
    });
    expect(row.status).not.toBe(AppointmentStatus.CONFIRMED);
    await app.get(NotificationService).flushPending();
    expect(
      await prisma.notification.count({
        where: { type: 'APPOINTMENT_CONFIRMED' },
      }),
    ).toBe(0);
  });

  it('accepted proposal blocks overlapping proposal create (D4)', async () => {
    const first = await acceptedProposal({
      astroPhone: '+94776660004',
      customerPhone: '+94776661004',
    });

    const from = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 2 })
      .toISODate()!;
    const to = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 5 })
      .toISODate()!;
    const slots = await request(app.getHttpServer())
      .get(`/astrologers/${first.astro.profileId}/availability/slots`)
      .query({ from, to, durationMinutes: 30 })
      .expect(200);
    const otherSlot = (
      slots.body.slots as Array<{ startAt: string; endAt: string }>
    ).find((s) => s.startAt !== first.slot.startAt);
    expect(otherSlot).toBeTruthy();

    const customerB = await registerPublic('+94776661005', 'Overlap B');
    const createdB = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${customerB.body.accessToken}`)
      .send({
        astrologerId: first.astro.profileId,
        serviceId: first.astro.serviceId,
        preferredStartAt: otherSlot!.startAt,
        preferredEndAt: otherSlot!.endAt,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${createdB.body.id}/accept`)
      .set('Authorization', `Bearer ${first.astro.token}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/astrologers/me/consultations/${createdB.body.id}/proposals`)
      .set('Authorization', `Bearer ${first.astro.token}`)
      .send({ proposedStartAt: first.slot.startAt, durationMinutes: 30 })
      .expect(400);
  });

  it('rejects client-supplied amount / start / end on checkout', async () => {
    const ctx = await acceptedProposal({
      astroPhone: '+94776660006',
      customerPhone: '+94776661006',
    });
    await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({
        amount: '1.00',
        startAt: '2020-01-01T00:00:00.000Z',
        endAt: '2020-01-01T00:30:00.000Z',
        paid: true,
      })
      .expect(400);
  });

  it('PAYMENT_PENDING hold occupies the public slot until expiry', async () => {
    const ctx = await acceptedProposal({
      astroPhone: '+94776660007',
      customerPhone: '+94776661007',
      slotIndex: 0,
    });
    await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);

    const from = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 2 })
      .toISODate()!;
    const to = DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 5 })
      .toISODate()!;
    const occupied = await request(app.getHttpServer())
      .get(`/astrologers/${ctx.astro.profileId}/availability/slots`)
      .query({ from, to, durationMinutes: 30 })
      .expect(200);
    const taken = (occupied.body.slots as Array<{ startAt: string }>).some(
      (s) => s.startAt === ctx.slot.startAt,
    );
    expect(taken).toBe(false);

    const hold = await prisma.appointment.findFirstOrThrow({
      where: { consultationId: ctx.consultationId },
    });
    await prisma.appointment.update({
      where: { id: hold.id },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });

    const expiredView = await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}/appointment`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(expiredView.body.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);

    const stillBlocked = await request(app.getHttpServer())
      .get(`/astrologers/${ctx.astro.profileId}/availability/slots`)
      .query({ from, to, durationMinutes: 30 })
      .expect(200);
    const stillTaken = (
      stillBlocked.body.slots as Array<{ startAt: string }>
    ).some((s) => s.startAt === ctx.slot.startAt);
    expect(stillTaken).toBe(false);
  });
});

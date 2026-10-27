import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DateTime } from 'luxon';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  PaymentStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { NotificationService } from '../src/notifications/notification.service';
import { AppointmentLifecycleService } from '../src/payments/appointment-lifecycle.service';
import { createTestSessionEvidenceCapability } from './support/session-evidence-test-harness';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(90_000);

/** supertest types `res.body` as `any`; read it through an explicit shape. */
const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
type IdBody = { id: string };
type AuthBody = { accessToken: string };
type SlotsBody = { slots: Array<{ startAt: string; endAt: string }> };
type AppointmentBody = {
  status: string;
  refundObligation: string | null;
};
type CheckoutBody = {
  appointment: {
    id: string;
    payment: { latestAttempt: { merchantReference: string } };
  };
};

type DetailBody = {
  status: string;
  appointment: {
    status: string;
    refundObligation: string | null;
    manualReviewRequired: boolean;
    actualDurationSeconds: number | null;
  };
  actionability: {
    stage: string;
    isClosed: boolean;
    canCheckout: boolean;
    canPropose: boolean;
    canCancelAppointment: boolean;
  };
};

describe('Phase 1 appointment lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let authService: AuthService;
  let tokenService: TokenService;
  let usersService: UsersService;
  let lifecycle: AppointmentLifecycleService;

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
    lifecycle = app.get(AppointmentLifecycleService);
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
      email: 'admin-phase1@welapathkade.test',
      password: 'AdminPass1!',
      phone: '+94776669998',
      name: 'Admin P1',
    });
    const session = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
    return session.accessToken;
  }

  async function details(ctx: {
    consultationId: string;
    customerToken: string;
    astroToken: string;
  }) {
    const customer = await http()
      .get(`/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    const astrologer = await http()
      .get(`/astrologers/me/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .expect(200);
    return {
      customer: customer.body as DetailBody,
      astrologer: astrologer.body as DetailBody,
    };
  }

  /** Full journey to a CONFIRMED appointment (mock payment). */
  async function confirmedAppointment(astroPhone: string, custPhone: string) {
    const admin = await adminToken();
    const service = await http()
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        code: `LC_${Date.now()}_${astroPhone.slice(-4)}`,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const astroToken = await register(
      astroPhone,
      'Astro LC',
      'ASTROLOGER_REGISTRATION',
    );
    await http()
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({
        displayName: 'Astro LC',
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
      'LC Customer',
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

    return {
      astroToken,
      customerToken,
      consultationId,
      proposalId: bodyOf<IdBody>(proposal).id,
      appointmentId: bodyOf<CheckoutBody>(checkout).appointment.id,
      profileId: profile.id,
      range,
      startAt: new Date(slot.startAt),
    };
  }

  it('customer cancellation: 100% refund obligation, no money moved, slot freed, no revival', async () => {
    const ctx = await confirmedAppointment('+94776670001', '+94776671001');

    const before = await details(ctx);
    expect(before.customer.status).toBe('ACCEPTED');
    expect(before.customer.actionability).toMatchObject({
      stage: 'CONFIRMED',
      canCheckout: false,
      canCancelAppointment: true,
      isClosed: false,
    });

    // The customer can cancel through the HTTP API even when the session is near.
    const res = await http()
      .post(`/consultations/${ctx.consultationId}/appointment/cancel`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ reason: 'plans changed' })
      .expect(201);
    expect(bodyOf<AppointmentBody>(res).status).toBe(
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
    );
    expect(bodyOf<AppointmentBody>(res).refundObligation).toBe(
      'FULL_REFUND_DUE',
    );

    // Consultation closed in the same transaction; appointment keeps the reason.
    const after = await details(ctx);
    for (const view of [after.customer, after.astrologer]) {
      expect(view.status).toBe('CANCELLED');
      expect(view.appointment.status).toBe(
        AppointmentStatus.CANCELLED_BY_CUSTOMER,
      );
      expect(view.appointment.refundObligation).toBe('FULL_REFUND_DUE');
      expect(view.actionability).toMatchObject({
        stage: 'CANCELLED_BY_CUSTOMER',
        isClosed: true,
        canCheckout: false,
        canCancelAppointment: false,
        canPropose: false,
      });
    }
    expect(
      (
        await prisma.consultation.findUniqueOrThrow({
          where: { id: ctx.consultationId },
        })
      ).completedAt,
    ).toBeNull();
    // The list shows the closed state too.
    const list = await http()
      .get('/consultations/me')
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(bodyOf<DetailBody[]>(list)[0].status).toBe('CANCELLED');

    // Obligation only: the payment is untouched (no refund was issued).
    const payment = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: ctx.appointmentId },
    });
    expect(payment.status).toBe(PaymentStatus.PAID);

    // Repeat is idempotent.
    const repeat = await http()
      .post(`/consultations/${ctx.consultationId}/appointment/cancel`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({})
      .expect(201);
    expect(bodyOf<AppointmentBody>(repeat).status).toBe(
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
    );

    // The slot is public again.
    const slots = await http()
      .get(`/astrologers/${ctx.profileId}/availability/slots`)
      .query(ctx.range)
      .expect(200);
    expect(
      bodyOf<SlotsBody>(slots).slots.some(
        (s) => new Date(s.startAt).getTime() === ctx.startAt.getTime(),
      ),
    ).toBe(true);

    // A cancelled appointment cannot be revived through checkout.
    await http()
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(409);

    // No reliability incident for a customer cancellation.
    expect(await prisma.astrologerReliabilityIncident.count()).toBe(0);
  });

  it('astrologer cancellation records one reliability incident; other users are rejected', async () => {
    const ctx = await confirmedAppointment('+94776670002', '+94776671002');
    const stranger = await register(
      '+94776670099',
      'Other Astro',
      'ASTROLOGER_REGISTRATION',
    );
    const strangerCustomer = await register(
      '+94776671099',
      'Other Cust',
      'PUBLIC_REGISTRATION',
    );

    await http()
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/appointment/cancel`,
      )
      .set('Authorization', `Bearer ${stranger}`)
      .send({})
      .expect(404);
    await http()
      .post(`/consultations/${ctx.consultationId}/appointment/cancel`)
      .set('Authorization', `Bearer ${strangerCustomer}`)
      .send({})
      .expect(404);
    // Wrong role for the astrologer route.
    await http()
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/appointment/cancel`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({})
      .expect(403);
    expect(
      (
        await prisma.appointment.findUniqueOrThrow({
          where: { id: ctx.appointmentId },
        })
      ).status,
    ).toBe(AppointmentStatus.CONFIRMED);

    for (let i = 0; i < 2; i += 1) {
      const res = await http()
        .post(
          `/astrologers/me/consultations/${ctx.consultationId}/appointment/cancel`,
        )
        .set('Authorization', `Bearer ${ctx.astroToken}`)
        .send({ reason: 'unwell' })
        .expect(201);
      expect(bodyOf<AppointmentBody>(res).status).toBe(
        AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      );
      expect(bodyOf<AppointmentBody>(res).refundObligation).toBe(
        'FULL_REFUND_DUE',
      );
    }
    expect(
      await prisma.astrologerReliabilityIncident.count({
        where: { appointmentId: ctx.appointmentId, type: 'CANCELLATION' },
      }),
    ).toBe(1);
    const closed = await details(ctx);
    expect(closed.customer.status).toBe('CANCELLED');
    expect(closed.customer.actionability.stage).toBe('CANCELLED_BY_ASTROLOGER');
    expect(closed.astrologer.actionability.canPropose).toBe(false);
  });

  it('verified start/end completes once; duplicate and competing events cannot double-apply', async () => {
    const ctx = await confirmedAppointment('+94776670003', '+94776671003');

    await lifecycle.recordSessionStart(createTestSessionEvidenceCapability(), {
      eventId: 'evt-start-1',
      appointmentId: ctx.appointmentId,
      occurredAt: ctx.startAt,
    });
    const endAt = new Date(ctx.startAt.getTime() + 7 * 60_000 + 500);
    const results = await Promise.allSettled([
      lifecycle.recordSessionEnd(createTestSessionEvidenceCapability(), {
        eventId: 'evt-end-a',
        appointmentId: ctx.appointmentId,
        occurredAt: endAt,
      }),
      lifecycle.recordSessionEnd(createTestSessionEvidenceCapability(), {
        eventId: 'evt-end-b',
        appointmentId: ctx.appointmentId,
        occurredAt: endAt,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: ctx.appointmentId },
    });
    expect(row.status).toBe(AppointmentStatus.COMPLETED);
    expect(row.actualDurationSeconds).toBe(420);
    expect(row.sessionStartedAt?.getTime()).toBe(ctx.startAt.getTime());
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: ctx.consultationId },
    });
    expect(consultation.completedAt?.getTime()).toBe(endAt.getTime());
    expect(consultation.status).toBe('COMPLETED');
    const done = await details(ctx);
    expect(done.customer.status).toBe('COMPLETED');
    expect(done.customer.actionability).toMatchObject({
      stage: 'COMPLETED',
      isClosed: true,
      canCheckout: false,
    });
    expect(done.customer.appointment.actualDurationSeconds).toBe(420);
    // Internal event ids are never exposed.
    expect(JSON.stringify(done.customer)).not.toContain('evt-');

    // Replaying the winning event is a no-op; a cancel is now rejected.
    await lifecycle.recordSessionEnd(createTestSessionEvidenceCapability(), {
      eventId: row.sessionEndEventId!,
      appointmentId: ctx.appointmentId,
      occurredAt: endAt,
    });
    await http()
      .post(`/consultations/${ctx.consultationId}/appointment/cancel`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({})
      .expect(409);
  });

  it('exposes no public endpoint to start, complete or mark a no-show', async () => {
    const ctx = await confirmedAppointment('+94776670004', '+94776671004');
    for (const path of ['start', 'complete', 'end', 'no-show']) {
      await http()
        .post(`/consultations/${ctx.consultationId}/appointment/${path}`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .send({ durationSeconds: 3600, status: 'COMPLETED' })
        .expect(404);
    }
    expect(
      (
        await prisma.appointment.findUniqueOrThrow({
          where: { id: ctx.appointmentId },
        })
      ).status,
    ).toBe(AppointmentStatus.CONFIRMED);
  });

  it('concurrent cancel vs verified start yields exactly one consistent outcome', async () => {
    const ctx = await confirmedAppointment('+94776670005', '+94776671005');
    const results = await Promise.allSettled([
      http()
        .post(`/consultations/${ctx.consultationId}/appointment/cancel`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .send({}),
      lifecycle.recordSessionStart(createTestSessionEvidenceCapability(), {
        eventId: 'evt-race',
        appointmentId: ctx.appointmentId,
        occurredAt: ctx.startAt,
      }),
    ]);
    expect(results).toHaveLength(2);
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: ctx.appointmentId },
    });
    expect([
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
      AppointmentStatus.IN_PROGRESS,
    ]).toContain(row.status);
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: ctx.consultationId },
    });
    if (row.status === AppointmentStatus.CANCELLED_BY_CUSTOMER) {
      expect(row.sessionStartedAt).toBeNull();
      expect(consultation.status).toBe('CANCELLED');
    } else {
      expect(row.cancelledAt).toBeNull();
      expect(row.refundObligation).toBeNull();
      expect(consultation.status).toBe('ACCEPTED');
    }
  });

  it('no-show outcomes persist after the grace period (verified attendance, server clock)', async () => {
    const ctx = await confirmedAppointment('+94776670006', '+94776671006');
    const afterGrace = new Date(ctx.startAt.getTime() + 11 * 60_000);

    // Too early: the grace period has not elapsed.
    await expect(
      lifecycle.recordNoShow(
        createTestSessionEvidenceCapability(),
        {
          appointmentId: ctx.appointmentId,
          customerJoined: false,
          astrologerJoined: true,
        },
        new Date(ctx.startAt.getTime() + 5 * 60_000),
      ),
    ).rejects.toThrow(/grace/);

    const view = await lifecycle.recordNoShow(
      createTestSessionEvidenceCapability(),
      {
        appointmentId: ctx.appointmentId,
        customerJoined: false,
        astrologerJoined: true,
      },
      afterGrace,
    );
    expect(view.status).toBe(AppointmentStatus.NO_SHOW_CUSTOMER);
    expect(view.manualReviewRequired).toBe(true);
    expect(view.refundObligation).toBeNull();
    expect(await prisma.astrologerReliabilityIncident.count()).toBe(0);

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: ctx.consultationId },
    });
    expect(consultation.status).toBe('CANCELLED');
    expect(consultation.completedAt).toBeNull();
    const shown = await details(ctx);
    expect(shown.customer.appointment.manualReviewRequired).toBe(true);
    expect(shown.customer.actionability.stage).toBe('NO_SHOW_CUSTOMER');
    expect(shown.customer.actionability.canCheckout).toBe(false);

    // Repeat is a no-op.
    await lifecycle.recordNoShow(
      createTestSessionEvidenceCapability(),
      {
        appointmentId: ctx.appointmentId,
        customerJoined: false,
        astrologerJoined: true,
      },
      afterGrace,
    );
  });

  it.each([
    ['astrologer no-show', true, false, 'NO_SHOW_ASTROLOGER', 1],
    ['both absent', false, false, 'NO_SHOW_BOTH', 0],
  ] as const)(
    '%s closes the consultation and keeps the refund obligation',
    async (
      _name,
      customerJoined,
      astrologerJoined,
      expectedStatus,
      incidents,
    ) => {
      const ctx = await confirmedAppointment('+94776670007', '+94776671007');
      const view = await lifecycle.recordNoShow(
        createTestSessionEvidenceCapability(),
        {
          appointmentId: ctx.appointmentId,
          customerJoined,
          astrologerJoined,
        },
        new Date(ctx.startAt.getTime() + 11 * 60_000),
      );
      expect(view.status).toBe(expectedStatus);
      expect(view.refundObligation).toBe('FULL_REFUND_DUE');
      const consultation = await prisma.consultation.findUniqueOrThrow({
        where: { id: ctx.consultationId },
      });
      expect(consultation.status).toBe('CANCELLED');
      expect(consultation.completedAt).toBeNull();
      expect(await prisma.astrologerReliabilityIncident.count()).toBe(
        incidents,
      );
      const shown = await details(ctx);
      expect(shown.astrologer.actionability.stage).toBe(expectedStatus);
    },
  );

  it('rolls back the appointment transition when the consultation is in an unexpected state', async () => {
    const ctx = await confirmedAppointment('+94776670008', '+94776671008');
    // Force an inconsistent consultation (test database only).
    await prisma.consultation.update({
      where: { id: ctx.consultationId },
      data: { status: 'EXPIRED' },
    });

    await http()
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/appointment/cancel`,
      )
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({})
      .expect(409);

    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: ctx.appointmentId },
    });
    expect(row.status).toBe(AppointmentStatus.CONFIRMED);
    expect(row.cancelledAt).toBeNull();
    expect(row.refundObligation).toBeNull();
    // The incident written after the appointment update was rolled back too.
    expect(await prisma.astrologerReliabilityIncident.count()).toBe(0);
    expect(
      (
        await prisma.consultation.findUniqueOrThrow({
          where: { id: ctx.consultationId },
        })
      ).status,
    ).toBe('EXPIRED');
  });
  describe('B1: cancellation time rules over HTTP', () => {
    type Ctx = Awaited<ReturnType<typeof confirmedAppointment>>;

    /** Moves the (test-database) appointment start relative to now. */
    async function startsIn(ctx: Ctx, offsetMs: number) {
      const startAt = new Date(Date.now() + offsetMs);
      await prisma.appointment.update({
        where: { id: ctx.appointmentId },
        data: { startAt, endAt: new Date(startAt.getTime() + 30 * 60_000) },
      });
    }

    const customerCancel = (ctx: Ctx) =>
      http()
        .post(`/consultations/${ctx.consultationId}/appointment/cancel`)
        .set('Authorization', `Bearer ${ctx.customerToken}`)
        .send({});
    const astrologerCancel = (ctx: Ctx) =>
      http()
        .post(
          `/astrologers/me/consultations/${ctx.consultationId}/appointment/cancel`,
        )
        .set('Authorization', `Bearer ${ctx.astroToken}`)
        .send({});

    async function expectUntouched(ctx: Ctx) {
      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: ctx.appointmentId },
      });
      expect(row.status).toBe(AppointmentStatus.CONFIRMED);
      expect(row.cancelledAt).toBeNull();
      expect(row.refundObligation).toBeNull();
      expect(row.refundObligationRecordedAt).toBeNull();
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: ctx.consultationId },
          })
        ).status,
      ).toBe('ACCEPTED');
      expect(await prisma.astrologerReliabilityIncident.count()).toBe(0);
    }

    it('inside the join window (before the start) both parties may still cancel', async () => {
      const a = await confirmedAppointment('+94776670021', '+94776671021');
      await startsIn(a, 5 * 60_000);
      const res = await customerCancel(a).expect(201);
      expect(bodyOf<AppointmentBody>(res).status).toBe(
        AppointmentStatus.CANCELLED_BY_CUSTOMER,
      );
      expect(bodyOf<AppointmentBody>(res).refundObligation).toBe(
        'FULL_REFUND_DUE',
      );

      const b = await confirmedAppointment('+94776670022', '+94776671022');
      await startsIn(b, 5 * 60_000);
      const res2 = await astrologerCancel(b).expect(201);
      expect(bodyOf<AppointmentBody>(res2).status).toBe(
        AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      );
      expect(
        await prisma.astrologerReliabilityIncident.count({
          where: { appointmentId: b.appointmentId },
        }),
      ).toBe(1);
    });

    it.each([
      ['just after the scheduled start', -30_000],
      ['inside the late-grace period', -5 * 60_000],
      ['after the grace period', -30 * 60_000],
      ['a day after the start', -24 * 3_600_000],
    ])(
      '%s: both parties are refused and nothing changes',
      async (_n, offset) => {
        const ctx = await confirmedAppointment('+94776670023', '+94776671023');
        await startsIn(ctx, offset);

        await customerCancel(ctx).expect(409);
        await astrologerCancel(ctx).expect(409);
        await expectUntouched(ctx);

        // Time alone is not an attendance outcome: no automatic no-show.
        const detail = await details(ctx);
        expect(detail.customer.status).toBe('ACCEPTED');
        expect(detail.customer.appointment.status).toBe(
          AppointmentStatus.CONFIRMED,
        );
        expect(detail.customer.actionability.stage).toBe('CONFIRMED');
        expect(detail.customer.actionability.canCancelAppointment).toBe(false);
        expect(detail.astrologer.actionability.canCancelAppointment).toBe(
          false,
        );
      },
    );

    it('before the start the server offers cancellation; the offer disappears at the start', async () => {
      const ctx = await confirmedAppointment('+94776670024', '+94776671024');
      await startsIn(ctx, 3_600_000);
      expect(
        (await details(ctx)).customer.actionability.canCancelAppointment,
      ).toBe(true);
      await startsIn(ctx, -1_000);
      expect(
        (await details(ctx)).customer.actionability.canCancelAppointment,
      ).toBe(false);
    });

    it('a repeated cancellation after the start is still idempotent', async () => {
      const ctx = await confirmedAppointment('+94776670025', '+94776671025');
      await customerCancel(ctx).expect(201);
      await startsIn(ctx, -10 * 60_000);
      const again = await customerCancel(ctx).expect(201);
      expect(bodyOf<AppointmentBody>(again).status).toBe(
        AppointmentStatus.CANCELLED_BY_CUSTOMER,
      );
      // The astrologer cannot cancel what the customer already cancelled.
      await astrologerCancel(ctx).expect(409);
    });

    it('simultaneous customer and astrologer cancellations produce exactly one outcome', async () => {
      const ctx = await confirmedAppointment('+94776670026', '+94776671026');
      const [c, a] = await Promise.all([
        customerCancel(ctx),
        astrologerCancel(ctx),
      ]);
      expect([c.status, a.status].sort()).toEqual([201, 409]);

      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: ctx.appointmentId },
      });
      const astrologerWon =
        row.status === AppointmentStatus.CANCELLED_BY_ASTROLOGER;
      expect(
        astrologerWon || row.status === AppointmentStatus.CANCELLED_BY_CUSTOMER,
      ).toBe(true);
      expect(row.refundObligation).toBe('FULL_REFUND_DUE');
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: ctx.consultationId },
          })
        ).status,
      ).toBe('CANCELLED');
      // The reliability incident exists only if the astrologer's cancel won.
      expect(await prisma.astrologerReliabilityIncident.count()).toBe(
        astrologerWon ? 1 : 0,
      );
    });

    it('simultaneous duplicate customer cancellations apply exactly once', async () => {
      const ctx = await confirmedAppointment('+94776670027', '+94776671027');
      const results = await Promise.all([
        customerCancel(ctx),
        customerCancel(ctx),
        customerCancel(ctx),
      ]);
      // A duplicate that loses the race is either answered idempotently (201)
      // or safely rejected as a concurrent state change (409). Never a 5xx,
      // and at least one request wins.
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThan(0);

      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: ctx.appointmentId },
      });
      expect(row.status).toBe(AppointmentStatus.CANCELLED_BY_CUSTOMER);
      expect(row.refundObligation).toBe('FULL_REFUND_DUE');
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: ctx.consultationId },
          })
        ).status,
      ).toBe('CANCELLED');
      expect(await prisma.astrologerReliabilityIncident.count()).toBe(0);
    });
  });
});

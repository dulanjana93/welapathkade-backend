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
  ProposalStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { ExpirySweepRunner } from '../src/expiry/expiry-sweep.runner';
import { ExpirySweepService } from '../src/expiry/expiry-sweep.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(120_000);

type IdBody = { id: string };
type AuthBody = { accessToken: string };
type SlotsBody = { slots: Array<{ startAt: string; endAt: string }> };
type CheckoutBody = {
  appointment: {
    id: string;
    payment: { latestAttempt: { merchantReference: string } };
  };
};
const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

describe('B2 automated expiry (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let authService: AuthService;
  let tokenService: TokenService;
  let usersService: UsersService;
  let sweeper: ExpirySweepService;

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
    sweeper = app.get(ExpirySweepService);
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
      email: 'admin-b2@welapathkade.test',
      password: 'AdminPass1!',
      phone: '+94776669997',
      name: 'Admin B2',
    });
    const session = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
    return session.accessToken;
  }

  const range = () => ({
    from: DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 2 })
      .toISODate()!,
    to: DateTime.now()
      .setZone(BUSINESS_TIMEZONE)
      .plus({ days: 5 })
      .toISODate()!,
    durationMinutes: 30,
  });

  /** An approved, bookable astrologer, a customer, and a PENDING request. */
  async function pendingRequest(astroPhone: string, custPhone: string) {
    const admin = await adminToken();
    const service = await http()
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        code: `B2_${Date.now()}_${astroPhone.slice(-4)}`,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);
    const serviceId = bodyOf<IdBody>(service).id;

    const astroToken = await register(
      astroPhone,
      'Astro B2',
      'ASTROLOGER_REGISTRATION',
    );
    await http()
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({
        displayName: 'Astro B2',
        bio: 'Experienced',
        experienceYears: 5,
        city: 'Colombo',
        district: 'Colombo',
      })
      .expect(200);
    await http()
      .post('/astrologers/me/services')
      .set('Authorization', `Bearer ${astroToken}`)
      .send({ serviceId, price: 1500 })
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

    const slots = await http()
      .get(`/astrologers/${profile.id}/availability/slots`)
      .query(range())
      .expect(200);
    const slot = bodyOf<SlotsBody>(slots).slots[0];

    const customerToken = await register(
      custPhone,
      'B2 Customer',
      'PUBLIC_REGISTRATION',
    );
    const created = await http()
      .post('/consultations')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        astrologerId: profile.id,
        serviceId,
        preferredStartAt: slot.startAt,
        preferredEndAt: slot.endAt,
      })
      .expect(201);
    return {
      astroToken,
      customerToken,
      profileId: profile.id,
      slot,
      consultationId: bodyOf<IdBody>(created).id,
    };
  }

  /** Request accepted, proposal made and accepted by the customer. */
  async function acceptedProposal(astroPhone: string, custPhone: string) {
    const ctx = await pendingRequest(astroPhone, custPhone);
    await http()
      .post(`/astrologers/me/consultations/${ctx.consultationId}/accept`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .expect(201);
    const proposal = await http()
      .post(`/astrologers/me/consultations/${ctx.consultationId}/proposals`)
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .send({ proposedStartAt: ctx.slot.startAt, durationMinutes: 30 })
      .expect(201);
    const proposalId = bodyOf<IdBody>(proposal).id;
    await http()
      .post(
        `/consultations/${ctx.consultationId}/proposals/${proposalId}/accept`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    return { ...ctx, proposalId };
  }

  type Accepted = Awaited<ReturnType<typeof acceptedProposal>>;

  async function checkout(ctx: Accepted) {
    const res = await http()
      .post(
        `/consultations/${ctx.consultationId}/proposals/${ctx.proposalId}/checkout`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    const body = bodyOf<CheckoutBody>(res);
    return {
      appointmentId: body.appointment.id,
      merchantReference:
        body.appointment.payment.latestAttempt.merchantReference,
    };
  }

  const payCallback = (merchantReference: string) =>
    http()
      .post('/payments/callbacks/mock')
      .send({ merchantReference, success: true });

  async function holdRows(appointmentId: string) {
    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
    });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { appointmentId },
    });
    const attempts = await prisma.paymentAttempt.findMany({
      where: { paymentId: payment.id },
    });
    return { appointment, payment, attempts };
  }

  async function slotIsOffered(ctx: Accepted) {
    const res = await http()
      .get(`/astrologers/${ctx.profileId}/availability/slots`)
      .query(range())
      .expect(200);
    return bodyOf<SlotsBody>(res).slots.some(
      (s) => s.startAt === ctx.slot.startAt,
    );
  }

  /** Invariant: CONFIRMED appointment <=> PAID payment, always. */
  function expectConsistentPair(
    rows: Awaited<ReturnType<typeof holdRows>>,
  ): void {
    expect(rows.appointment.status === AppointmentStatus.CONFIRMED).toBe(
      rows.payment.status === PaymentStatus.PAID,
    );
  }

  // -------------------------------------------------------------------------
  it('the sweeper is disabled by default in the test environment', () => {
    expect(app.get(ExpirySweepRunner).isRunning).toBe(false);
  });

  // -------------------------------------------------------------------------
  describe('payment reservations', () => {
    it.each([
      ['1 ms before expiry stays valid', -1, false],
      ['exactly at expiry is expired', 0, true],
      ['1 ms after expiry is expired', 1, true],
    ])('%s', async (_name, offsetMs, expectExpired) => {
      const ctx = await acceptedProposal('+94776680001', '+94776681001');
      const { appointmentId } = await checkout(ctx);
      const expiresAt = new Date(Date.now() - 5 * 60_000);
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { reservationExpiresAt: expiresAt },
      });

      const result = await sweeper.runOnce(
        new Date(expiresAt.getTime() + offsetMs),
      );

      const rows = await holdRows(appointmentId);
      if (expectExpired) {
        expect(result.reservations).toBe(1);
        expect(rows.appointment.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);
        expect(rows.payment.status).toBe(PaymentStatus.EXPIRED);
        expect(
          rows.attempts.every((a) => a.status === PaymentStatus.EXPIRED),
        ).toBe(true);
      } else {
        expect(result.reservations).toBe(0);
        expect(rows.appointment.status).toBe(AppointmentStatus.PAYMENT_PENDING);
        expect(rows.payment.status).toBe(PaymentStatus.PENDING);
        expect(
          rows.attempts.every((a) => a.status === PaymentStatus.PENDING),
        ).toBe(true);
      }
      expect(result.errors).toEqual([]);
    });

    it('running the sweeper twice has no duplicate effects', async () => {
      const ctx = await acceptedProposal('+94776680002', '+94776681002');
      const { appointmentId } = await checkout(ctx);
      const expiresAt = new Date(Date.now() - 60_000);
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { reservationExpiresAt: expiresAt },
      });
      const now = new Date(expiresAt.getTime() + 1);

      const first = await sweeper.runOnce(now);
      const before = await holdRows(appointmentId);
      const second = await sweeper.runOnce(now);
      const after = await holdRows(appointmentId);

      expect(first.reservations).toBe(1);
      expect(second).toMatchObject({
        reservations: 0,
        payments: 0,
        attempts: 0,
        consultations: 0,
        errors: [],
      });
      expect(after.appointment.updatedAt).toEqual(before.appointment.updatedAt);
      expect(after.payment.updatedAt).toEqual(before.payment.updatedAt);
    });

    it('concurrent sweeps apply each change exactly once', async () => {
      const ctx = await acceptedProposal('+94776680003', '+94776681003');
      const { appointmentId } = await checkout(ctx);
      const expiresAt = new Date(Date.now() - 60_000);
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { reservationExpiresAt: expiresAt },
      });
      const now = new Date(expiresAt.getTime() + 1);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => sweeper.runOnce(now)),
      );

      const sum = (key: 'reservations' | 'payments' | 'attempts') =>
        results.reduce((acc, r) => acc + r[key], 0);
      expect(sum('reservations')).toBe(1);
      expect(sum('payments')).toBe(1);
      expect(sum('attempts')).toBe(1);
      for (const r of results) expect(r.errors).toEqual([]);
      const rows = await holdRows(appointmentId);
      expect(rows.appointment.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);
      expect(rows.payment.status).toBe(PaymentStatus.EXPIRED);
    });

    it('an expired hold keeps blocking the slot via its accepted proposal, and checkout can be retried', async () => {
      const ctx = await acceptedProposal('+94776680004', '+94776681004');
      const first = await checkout(ctx);
      expect(await slotIsOffered(ctx)).toBe(false);

      const expiresAt = new Date(Date.now() - 60_000);
      await prisma.appointment.update({
        where: { id: first.appointmentId },
        data: { reservationExpiresAt: expiresAt },
      });
      await sweeper.runOnce(new Date(expiresAt.getTime() + 1));

      // The hold is expired, but the accepted proposal is untouched...
      const rows = await holdRows(first.appointmentId);
      expect(rows.appointment.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);
      expect(
        (
          await prisma.consultationProposal.findUniqueOrThrow({
            where: { id: ctx.proposalId },
          })
        ).status,
      ).toBe(ProposalStatus.ACCEPTED);
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: ctx.consultationId },
          })
        ).status,
      ).toBe(ConsultationStatus.ACCEPTED);
      // ...so the slot is still blocked for everyone else.
      expect(await slotIsOffered(ctx)).toBe(false);

      // The same customer can retry checkout for the same proposal.
      const retry = await checkout(ctx);
      expect(retry.appointmentId).toBe(first.appointmentId);
      expect(retry.merchantReference).not.toBe(first.merchantReference);
      const retried = await holdRows(first.appointmentId);
      expect(retried.appointment.status).toBe(
        AppointmentStatus.PAYMENT_PENDING,
      );
      expect(
        retried.appointment.reservationExpiresAt.getTime(),
      ).toBeGreaterThan(Date.now());
      expect(retried.payment.status).toBe(PaymentStatus.PENDING);

      // The retried hold can be paid.
      await payCallback(retry.merchantReference).expect(201);
      const paid = await holdRows(first.appointmentId);
      expect(paid.appointment.status).toBe(AppointmentStatus.CONFIRMED);
      expect(paid.payment.status).toBe(PaymentStatus.PAID);
    });

    it('a successfully paid appointment is never expired', async () => {
      const ctx = await acceptedProposal('+94776680005', '+94776681005');
      const { appointmentId, merchantReference } = await checkout(ctx);
      await payCallback(merchantReference).expect(201);
      // Even if its (now irrelevant) hold deadline is long past.
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { reservationExpiresAt: new Date(Date.now() - 3_600_000) },
      });

      const result = await sweeper.runOnce(new Date(Date.now() + 86_400_000));

      expect(result.reservations).toBe(0);
      expect(result.payments).toBe(0);
      const rows = await holdRows(appointmentId);
      expect(rows.appointment.status).toBe(AppointmentStatus.CONFIRMED);
      expect(rows.payment.status).toBe(PaymentStatus.PAID);
      expect(rows.attempts.every((a) => a.status === PaymentStatus.PAID)).toBe(
        true,
      );
    });

    it('recovers on the next sweep when an earlier run failed after flipping the hold', async () => {
      const ctx = await acceptedProposal('+94776680006', '+94776681006');
      const { appointmentId } = await checkout(ctx);
      const expiresAt = new Date(Date.now() - 60_000);
      // State left behind by a run that flipped the appointment and then
      // failed before expiring its payment and attempts.
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.PAYMENT_EXPIRED,
          reservationExpiresAt: expiresAt,
        },
      });
      const stuck = await holdRows(appointmentId);
      expect(stuck.payment.status).toBe(PaymentStatus.PENDING);

      const result = await sweeper.runOnce(new Date(expiresAt.getTime() + 1));

      expect(result.reservations).toBe(0); // nothing left to flip
      expect(result.payments).toBe(1);
      expect(result.attempts).toBe(1);
      const healed = await holdRows(appointmentId);
      expect(healed.payment.status).toBe(PaymentStatus.EXPIRED);
      expect(
        healed.attempts.every((a) => a.status === PaymentStatus.EXPIRED),
      ).toBe(true);
    });

    it('a revived hold is not expired by the recovery step', async () => {
      const ctx = await acceptedProposal('+94776680007', '+94776681007');
      const first = await checkout(ctx);
      const expiresAt = new Date(Date.now() - 60_000);
      await prisma.appointment.update({
        where: { id: first.appointmentId },
        data: { reservationExpiresAt: expiresAt },
      });
      await sweeper.runOnce(new Date(expiresAt.getTime() + 1));
      await checkout(ctx); // customer retries: hold is live again

      const result = await sweeper.runOnce(new Date());

      expect(result.reservations).toBe(0);
      expect(result.payments).toBe(0);
      const rows = await holdRows(first.appointmentId);
      expect(rows.appointment.status).toBe(AppointmentStatus.PAYMENT_PENDING);
      expect(rows.payment.status).toBe(PaymentStatus.PENDING);
    });

    it.each([1, 2, 3])(
      'payment success racing expiry has exactly one valid outcome (round %i)',
      async (round) => {
        const ctx = await acceptedProposal(
          `+9477668010${round}`,
          `+9477668110${round}`,
        );
        const { appointmentId, merchantReference } = await checkout(ctx);
        // A deadline far enough ahead that the real-clock callback is still
        // inside the hold, while the sweeper is told "now == deadline".
        const expiresAt = new Date(Date.now() + 2_000);
        await prisma.appointment.update({
          where: { id: appointmentId },
          data: { reservationExpiresAt: expiresAt },
        });

        const [callback, sweep] = await Promise.all([
          payCallback(merchantReference),
          sweeper.runOnce(expiresAt),
        ]);

        const rows = await holdRows(appointmentId);
        expectConsistentPair(rows);
        if (rows.appointment.status === AppointmentStatus.CONFIRMED) {
          expect(callback.status).toBe(201);
          expect(rows.payment.status).toBe(PaymentStatus.PAID);
          expect(sweep.reservations).toBe(0);
        } else {
          expect(rows.appointment.status).toBe(
            AppointmentStatus.PAYMENT_EXPIRED,
          );
          expect(callback.status).toBe(409);
          expect(rows.payment.status).not.toBe(PaymentStatus.PAID);
          expect(sweep.reservations).toBe(1);
        }
        expect(sweep.errors).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe('consultation requests', () => {
    it.each([
      ['1 ms before expiry stays valid', -1, false],
      ['exactly at expiry is expired', 0, true],
      ['1 ms after expiry is expired', 1, true],
    ])('%s', async (_name, offsetMs, expectExpired) => {
      const ctx = await pendingRequest('+94776680011', '+94776681011');
      const expiresAt = new Date(Date.now() - 60_000);
      await prisma.consultation.update({
        where: { id: ctx.consultationId },
        data: { expiresAt },
      });

      const result = await sweeper.runOnce(
        new Date(expiresAt.getTime() + offsetMs),
      );

      const row = await prisma.consultation.findUniqueOrThrow({
        where: { id: ctx.consultationId },
      });
      expect(result.consultations).toBe(expectExpired ? 1 : 0);
      expect(row.status).toBe(
        expectExpired ? ConsultationStatus.EXPIRED : ConsultationStatus.PENDING,
      );
      expect(result.errors).toEqual([]);
    });

    it('an expired request can no longer be accepted, and a second sweep changes nothing', async () => {
      const ctx = await pendingRequest('+94776680012', '+94776681012');
      const expiresAt = new Date(Date.now() - 60_000);
      await prisma.consultation.update({
        where: { id: ctx.consultationId },
        data: { expiresAt },
      });
      const now = new Date(expiresAt.getTime() + 1);

      expect((await sweeper.runOnce(now)).consultations).toBe(1);
      expect((await sweeper.runOnce(now)).consultations).toBe(0);

      await http()
        .post(`/astrologers/me/consultations/${ctx.consultationId}/accept`)
        .set('Authorization', `Bearer ${ctx.astroToken}`)
        .expect(409);
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: ctx.consultationId },
          })
        ).status,
      ).toBe(ConsultationStatus.EXPIRED);
    });

    it('only PENDING requests expire: accepted and declined requests are untouched', async () => {
      const accepted = await acceptedProposal('+94776680013', '+94776681013');
      const declinedCtx = await pendingRequest('+94776680014', '+94776681014');
      await http()
        .post(
          `/astrologers/me/consultations/${declinedCtx.consultationId}/decline`,
        )
        .set('Authorization', `Bearer ${declinedCtx.astroToken}`)
        .send({})
        .expect(201);
      const past = new Date(Date.now() - 24 * 3_600_000);
      await prisma.consultation.updateMany({ data: { expiresAt: past } });

      const result = await sweeper.runOnce(new Date());

      expect(result.consultations).toBe(0);
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: accepted.consultationId },
          })
        ).status,
      ).toBe(ConsultationStatus.ACCEPTED);
      expect(
        (
          await prisma.consultation.findUniqueOrThrow({
            where: { id: declinedCtx.consultationId },
          })
        ).status,
      ).toBe(ConsultationStatus.DECLINED);
    });

    it.each([1, 2, 3])(
      'astrologer acceptance racing expiry has exactly one valid outcome (round %i)',
      async (round) => {
        const ctx = await pendingRequest(
          `+9477668020${round}`,
          `+9477668120${round}`,
        );
        const expiresAt = new Date(Date.now() + 2_000);
        await prisma.consultation.update({
          where: { id: ctx.consultationId },
          data: { expiresAt },
        });

        const [accept, sweep] = await Promise.all([
          http()
            .post(`/astrologers/me/consultations/${ctx.consultationId}/accept`)
            .set('Authorization', `Bearer ${ctx.astroToken}`),
          sweeper.runOnce(expiresAt),
        ]);

        const row = await prisma.consultation.findUniqueOrThrow({
          where: { id: ctx.consultationId },
        });
        if (row.status === ConsultationStatus.ACCEPTED) {
          expect(accept.status).toBe(201);
          expect(sweep.consultations).toBe(0);
          expect(row.respondedAt).not.toBeNull();
        } else {
          expect(row.status).toBe(ConsultationStatus.EXPIRED);
          expect(accept.status).toBe(409);
          expect(sweep.consultations).toBe(1);
        }
        expect(sweep.errors).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  it('a sweep creates no notification rows and no lifecycle side effects', async () => {
    const ctx = await acceptedProposal('+94776680021', '+94776681021');
    const { appointmentId } = await checkout(ctx);
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
    });
    const pending = await pendingRequest('+94776680022', '+94776681022');
    await prisma.consultation.update({
      where: { id: pending.consultationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await app.get(NotificationService).flushPending();
    const notificationsBefore = await prisma.notification.count();
    const incidentsBefore = await prisma.astrologerReliabilityIncident.count();

    const result = await sweeper.runOnce(new Date());

    expect(result.reservations + result.consultations).toBeGreaterThan(0);
    expect(await prisma.notification.count()).toBe(notificationsBefore);
    expect(await prisma.astrologerReliabilityIncident.count()).toBe(
      incidentsBefore,
    );
    const hold = await holdRows(appointmentId);
    expect(hold.appointment.refundObligation).toBeNull();
    expect(hold.appointment.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);
  });
});

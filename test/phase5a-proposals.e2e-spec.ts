import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DateTime } from 'luxon';
import {
  AstrologerProfileStatus,
  ConsultationStatus,
  ProposalStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { BUSINESS_TIMEZONE } from '../src/availability/availability.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(60_000);

describe('Phase 5A Consultation Proposals (e2e)', () => {
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
    await resetE2eDatabase(prisma);
    await resetE2eRedisOtps(redis);
  });

  afterAll(async () => {
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
      where: { phone: '+94775559999' },
    });
    const admin =
      existing ??
      (await usersService.createAdminUser({
        email: 'admin-phase5a@welapathkade.test',
        password: 'AdminPass1!',
        phone: '+94775559999',
        name: 'Admin 5A',
      }));
    return tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
  }

  async function seedBookableAstrologer(opts?: { phone?: string }) {
    const admin = await issueAdmin();
    const serviceRes = await request(app.getHttpServer())
      .post('/admin/services')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        code: `PROP_${Date.now()}`,
        nameSi: 'කේන්දර බැලීම',
        nameEn: 'Horoscope Reading',
        minPrice: 500,
        maxPrice: 5000,
      })
      .expect(201);

    const phone = opts?.phone ?? '+94775550001';
    const reg = await registerAstrologer(phone, 'Astro Proposer');
    const token = reg.body.accessToken as string;

    await request(app.getHttpServer())
      .patch('/astrologers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        displayName: 'Astro Proposer',
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
        price: 1500,
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
    };
  }

  async function pickFutureSlot(
    astrologerId: string,
    durationMinutes = 30,
  ) {
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
      .query({ from, to, durationMinutes })
      .expect(200);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    return slots.body.slots[0] as {
      startAt: string;
      endAt: string;
      localDate: string;
      startTime: string;
    };
  }

  async function createAcceptedConsultation(opts?: {
    astroPhone?: string;
    customerPhone?: string;
  }) {
    const astro = await seedBookableAstrologer({
      phone: opts?.astroPhone ?? '+94775550001',
    });
    const slot = await pickFutureSlot(astro.profileId);
    const customer = await registerPublic(
      opts?.customerPhone ?? '+94775551001',
      'Customer 5A',
    );

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

    return {
      astro,
      customerToken: customer.body.accessToken as string,
      consultationId: created.body.id as string,
      preferredSlot: slot,
    };
  }

  it('19–23. create proposal, customer lists/accepts, both sides see ACCEPTED', async () => {
    const ctx = await createAcceptedConsultation();
    const proposeSlot = await pickFutureSlot(ctx.astro.profileId, 60);

    const created = await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: proposeSlot.startAt,
        durationMinutes: 60,
      })
      .expect(201);

    expect(created.body.status).toBe(ProposalStatus.PENDING);
    expect(created.body.durationMinutes).toBe(60);
    expect(created.body.proposedStartAt).toBe(proposeSlot.startAt);
    expect(created.body.proposedEndAt).toBe(proposeSlot.endAt);
    expect(created.body.timezone).toBe(BUSINESS_TIMEZONE);
    expect(created.body.respondedAt).toBeNull();

    // No reservation side effects beyond existing booking guard.
    const proposalCount = await prisma.consultationProposal.count();
    expect(proposalCount).toBe(1);

    const listed = await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}/proposals`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(created.body.id);

    const accepted = await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${created.body.id}/accept`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);
    expect(accepted.body.status).toBe(ProposalStatus.ACCEPTED);
    expect(accepted.body.respondedAt).toBeTruthy();

    const customerDetail = await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(customerDetail.body.status).toBe(ConsultationStatus.ACCEPTED);
    expect(customerDetail.body.acceptedProposal.status).toBe(
      ProposalStatus.ACCEPTED,
    );
    expect(customerDetail.body.pendingProposal).toBeNull();
    expect(customerDetail.body.proposals).toHaveLength(1);

    const astroListed = await request(app.getHttpServer())
      .get(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .expect(200);
    expect(astroListed.body[0].status).toBe(ProposalStatus.ACCEPTED);
  });

  it('24. reject then create second proposal; history retained', async () => {
    const ctx = await createAcceptedConsultation({
      astroPhone: '+94775550002',
      customerPhone: '+94775551002',
    });
    const slot1 = await pickFutureSlot(ctx.astro.profileId, 30);
    const first = await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: slot1.startAt,
        durationMinutes: 30,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${first.body.id}/reject`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);

    const slots = await request(app.getHttpServer())
      .get(`/astrologers/${ctx.astro.profileId}/availability/slots`)
      .query({
        from: DateTime.now().setZone(BUSINESS_TIMEZONE).plus({ days: 2 }).toISODate(),
        to: DateTime.now().setZone(BUSINESS_TIMEZONE).plus({ days: 6 }).toISODate(),
        durationMinutes: 30,
      })
      .expect(200);
    const slot2 = slots.body.slots[1] ?? slots.body.slots[0];

    const second = await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: slot2.startAt,
        durationMinutes: 30,
      })
      .expect(201);
    expect(second.body.status).toBe(ProposalStatus.PENDING);

    const history = await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}/proposals`)
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body.map((p: { status: string }) => p.status)).toEqual([
      ProposalStatus.PENDING,
      ProposalStatus.REJECTED,
    ]);
  });

  it('25. authorization failures', async () => {
    const ctx = await createAcceptedConsultation({
      astroPhone: '+94775550003',
      customerPhone: '+94775551003',
    });
    const other = await registerPublic('+94775551099', 'Other Customer');
    const slot = await pickFutureSlot(ctx.astro.profileId);

    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/consultations/${ctx.consultationId}/proposals`)
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${created.body.id}/accept`,
      )
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(404);
  });

  it('26. invalid state transitions', async () => {
    const ctx = await createAcceptedConsultation({
      astroPhone: '+94775550004',
      customerPhone: '+94775551004',
    });
    const slot = await pickFutureSlot(ctx.astro.profileId);

    // Cannot propose while consultation still PENDING — create a fresh pending one
    const pendingCustomer = await registerPublic('+94775551005', 'Pending Cust');
    const pending = await request(app.getHttpServer())
      .post('/consultations')
      .set('Authorization', `Bearer ${pendingCustomer.body.accessToken}`)
      .send({
        astrologerId: ctx.astro.profileId,
        serviceId: ctx.astro.serviceId,
        preferredStartAt: slot.startAt,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${pending.body.id}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(409);

    const first = await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(201);

    // Duplicate pending
    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({ proposedStartAt: slot.startAt, durationMinutes: 30 })
      .expect(409);

    await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${first.body.id}/accept`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(201);

    // Cannot reject after accept
    await request(app.getHttpServer())
      .post(
        `/consultations/${ctx.consultationId}/proposals/${first.body.id}/reject`,
      )
      .set('Authorization', `Bearer ${ctx.customerToken}`)
      .expect(409);

    // Cannot create after accepted
    const slots = await request(app.getHttpServer())
      .get(`/astrologers/${ctx.astro.profileId}/availability/slots`)
      .query({
        from: DateTime.now().setZone(BUSINESS_TIMEZONE).plus({ days: 2 }).toISODate(),
        to: DateTime.now().setZone(BUSINESS_TIMEZONE).plus({ days: 6 }).toISODate(),
        durationMinutes: 30,
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: slots.body.slots[1].startAt,
        durationMinutes: 30,
      })
      .expect(409);
  });

  it('27. availability validation on create', async () => {
    const ctx = await createAcceptedConsultation({
      astroPhone: '+94775550006',
      customerPhone: '+94775551006',
    });

    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: DateTime.now().plus({ minutes: 10 }).toUTC().toISO(),
        durationMinutes: 30,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: DateTime.now()
          .setZone(BUSINESS_TIMEZONE)
          .plus({ days: 40 })
          .toUTC()
          .toISO(),
        durationMinutes: 30,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: ctx.preferredSlot.startAt,
        durationMinutes: 0,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post(
        `/astrologers/me/consultations/${ctx.consultationId}/proposals`,
      )
      .set('Authorization', `Bearer ${ctx.astro.token}`)
      .send({
        proposedStartAt: ctx.preferredSlot.startAt,
        durationMinutes: 999,
      })
      .expect(400);
  });
});

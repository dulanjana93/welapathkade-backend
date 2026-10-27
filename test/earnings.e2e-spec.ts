import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  ConsultationStatus,
  LedgerCategory,
  LedgerEntryKind,
  PaymentStatus,
  Prisma,
  UserRole,
  UserStatus,
  type User,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { FinancialLedgerService } from '../src/settlement/financial-ledger.service';
import { FinancialSnapshotService } from '../src/settlement/financial-snapshot.service';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(120_000);

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

describe('Phase E me/earnings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokenService: TokenService;
  let usersService: UsersService;
  let snapshots: FinancialSnapshotService;
  let ledger: FinancialLedgerService;
  let seq = 0;

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
    tokenService = app.get(TokenService);
    usersService = app.get(UsersService);
    snapshots = app.get(FinancialSnapshotService);
    ledger = app.get(FinancialLedgerService);
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

  async function createUser(
    role: UserRole = UserRole.PUBLIC,
    referredByUserId: string | null = null,
  ) {
    seq += 1;
    return prisma.user.create({
      data: {
        phone: `+94775${String(100000 + seq).padStart(6, '0')}`,
        name: `${role}-earn-${seq}`,
        role,
        status: UserStatus.ACTIVE,
        referralCode: `ER${Date.now()}${seq}`,
        referredByUserId,
      },
    });
  }

  async function tokenFor(user: User) {
    const session = await tokenService.issueSession({
      user,
      deviceId: null,
      ip: null,
      userAgent: 'earnings-e2e',
    });
    return session.accessToken;
  }

  async function seedPostedWithReferrals() {
    const customerReferrer = await createUser(UserRole.PUBLIC);
    const astrologerReferrer = await createUser(UserRole.ASTROLOGER);
    const customer = await createUser(UserRole.PUBLIC, customerReferrer.id);
    const astroUser = await createUser(
      UserRole.ASTROLOGER,
      astrologerReferrer.id,
    );
    const amount = '1000.00';
    const startAt = new Date(Date.now() - 48 * 3_600_000);
    const completedAt = new Date(startAt.getTime() + 30 * 60_000);

    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astroUser.id,
        displayName: 'Earn Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
        district: 'Colombo',
        isOnline: true,
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `ERN_${Date.now()}_${seq}`,
        nameEn: 'Earn Service',
        nameSi: 'Earn Service',
        minPrice: new Prisma.Decimal(amount),
        maxPrice: new Prisma.Decimal(amount),
      },
    });
    const asvc = await prisma.astrologerService.create({
      data: {
        astrologerId: profile.id,
        serviceId: serviceRow.id,
        price: new Prisma.Decimal(amount),
      },
    });
    const consultation = await prisma.consultation.create({
      data: {
        customerId: customer.id,
        astrologerId: profile.id,
        astrologerServiceId: asvc.id,
        serviceId: serviceRow.id,
        serviceNameSi: serviceRow.nameSi,
        serviceNameEn: serviceRow.nameEn,
        status: ConsultationStatus.COMPLETED,
        requestedPrice: new Prisma.Decimal(amount),
        preferredStartAt: startAt,
        submittedAt: new Date(startAt.getTime() - 86_400_000),
        expiresAt: new Date(startAt.getTime() + 86_400_000),
        completedAt,
      },
    });
    const proposal = await prisma.consultationProposal.create({
      data: {
        consultationId: consultation.id,
        proposedStartAt: startAt,
        proposedEndAt: completedAt,
        durationMinutes: 30,
        status: 'ACCEPTED',
      },
    });
    const appointment = await prisma.appointment.create({
      data: {
        consultationId: consultation.id,
        proposalId: proposal.id,
        customerId: customer.id,
        astrologerId: profile.id,
        startAt,
        endAt: completedAt,
        durationMinutes: 30,
        status: AppointmentStatus.COMPLETED,
        amount: new Prisma.Decimal(amount),
        currency: 'LKR',
        reservationExpiresAt: new Date(startAt.getTime() - 60_000),
        confirmedAt: new Date(startAt.getTime() - 3_600_000),
        sessionStartedAt: startAt,
        sessionEndedAt: completedAt,
        actualDurationSeconds: 1800,
      },
    });
    await prisma.payment.create({
      data: {
        appointmentId: appointment.id,
        consultationId: consultation.id,
        amount: new Prisma.Decimal(amount),
        currency: 'LKR',
        status: PaymentStatus.PAID,
        paidAt: new Date(startAt.getTime() - 3_600_000),
      },
    });

    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      appointment.id,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) throw new Error('snapshot failed');
    const posted = await ledger.postSnapshot(snap.snapshot.id, now);
    expect(posted).toEqual(expect.objectContaining({ ok: true, posted: true }));

    return {
      customerReferrer,
      astrologerReferrer,
      customer,
      astroUser,
      appointmentId: appointment.id,
    };
  }

  it('returns own wallet and ledger for astrologer without platform residual', async () => {
    const ctx = await seedPostedWithReferrals();
    const token = await tokenFor(ctx.astroUser);

    const summary = await http()
      .get('/me/earnings/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = bodyOf<{
      availableBalance: string;
      byCategory: {
        ASTROLOGER_EARNING: { creditAmount: string; netAmount: string };
        ASTROLOGER_REFERRAL: { netAmount: string };
      };
    }>(summary);

    expect(body.availableBalance).toBe('800.00');
    expect(body.byCategory.ASTROLOGER_EARNING.creditAmount).toBe('800.00');
    expect(body.byCategory.ASTROLOGER_EARNING.netAmount).toBe('800.00');
    expect(body).not.toHaveProperty('byCategory.PLATFORM_RESIDUAL');

    const ledgerRes = await http()
      .get('/me/earnings/ledger')
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const page = bodyOf<{
      total: number;
      items: Array<{
        category: string;
        kind: string;
        signedAmount: string;
        appointmentId: string | null;
        idempotencyKey?: string;
      }>;
    }>(ledgerRes);

    expect(page.total).toBe(1);
    expect(page.items[0].category).toBe(LedgerCategory.ASTROLOGER_EARNING);
    expect(page.items[0].kind).toBe(LedgerEntryKind.CREDIT);
    expect(page.items[0].signedAmount).toBe('800.00');
    expect(page.items[0].appointmentId).toBe(ctx.appointmentId);
    expect(page.items[0].idempotencyKey).toBeUndefined();
    expect(
      page.items.every((i) => i.category !== LedgerCategory.PLATFORM_RESIDUAL),
    ).toBe(true);
  });

  it('returns customer referral earnings only for the referrer wallet owner', async () => {
    const ctx = await seedPostedWithReferrals();
    const referrerToken = await tokenFor(ctx.customerReferrer);
    const otherToken = await tokenFor(ctx.customer);

    const summary = await http()
      .get('/me/earnings/summary')
      .set('Authorization', `Bearer ${referrerToken}`)
      .expect(200);
    const body = bodyOf<{
      availableBalance: string;
      byCategory: { CUSTOMER_REFERRAL: { creditAmount: string } };
    }>(summary);
    expect(body.availableBalance).toBe('30.00');
    expect(body.byCategory.CUSTOMER_REFERRAL.creditAmount).toBe('30.00');

    const otherSummary = await http()
      .get('/me/earnings/summary')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    const other = bodyOf<{
      availableBalance: string;
      byCategory: { CUSTOMER_REFERRAL: { creditAmount: string } };
    }>(otherSummary);
    expect(other.availableBalance).toBe('0.00');
    expect(other.byCategory.CUSTOMER_REFERRAL.creditAmount).toBe('0.00');

    const ledgerRes = await http()
      .get('/me/earnings/ledger')
      .query({ category: LedgerCategory.CUSTOMER_REFERRAL })
      .set('Authorization', `Bearer ${referrerToken}`)
      .expect(200);
    const page = bodyOf<{ total: number; items: Array<{ category: string }> }>(
      ledgerRes,
    );
    expect(page.total).toBe(1);
    expect(page.items[0].category).toBe(LedgerCategory.CUSTOMER_REFERRAL);
  });

  it('forbids admin and unauthenticated access; GET is read-only', async () => {
    await http().get('/me/earnings/summary').expect(401);

    const admin = await usersService.createAdminUser({
      email: `admin-earn-${Date.now()}@welapathkade.test`,
      password: 'AdminPass1!',
      phone: `+9477599${String(++seq).padStart(4, '0')}`,
      name: 'Admin Earn',
    });
    const adminAuth = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: 'earnings-e2e-admin',
    });

    await http()
      .get('/me/earnings/summary')
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(403);

    await http()
      .post('/me/earnings/summary')
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(404);
  });

  it('rejects platform residual category on user ledger', async () => {
    const u = await createUser(UserRole.ASTROLOGER);
    const token = await tokenFor(u);
    await http()
      .get('/me/earnings/ledger')
      .query({ category: LedgerCategory.PLATFORM_RESIDUAL })
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});

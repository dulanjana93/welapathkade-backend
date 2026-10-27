import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  ConsultationStatus,
  FinancialSnapshotStatus,
  LedgerCategory,
  LedgerEntryKind,
  PaymentStatus,
  Prisma,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { FinancialLedgerService } from '../src/settlement/financial-ledger.service';
import { FinancialSnapshotService } from '../src/settlement/financial-snapshot.service';
import { SETTLEMENT_HOLD_MS } from '../src/settlement/settlement.constants';
import { UsersService } from '../src/users/users.service';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(120_000);

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
type AuthBody = { accessToken: string };
type CorrectionBody = {
  userId: string;
  referredByUserId: string | null;
  previousReferrerUserId: string | null;
  correctionId: string;
  auditLogId: string;
  correctedAt: string;
  reason: string;
};

describe('Phase C referral attribution correction (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let authService: AuthService;
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
    authService = app.get(AuthService);
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
    role: UserRole,
    referredByUserId?: string | null,
    status: UserStatus = UserStatus.ACTIVE,
  ) {
    seq += 1;
    return prisma.user.create({
      data: {
        phone: `+94773${String(100000 + seq).padStart(6, '0')}`,
        name: `${role}-${seq}`,
        role,
        status,
        referralCode: `RAC${Date.now()}${seq}`,
        referredByUserId: referredByUserId ?? null,
      },
    });
  }

  async function adminToken() {
    const admin = await usersService.createAdminUser({
      email: `admin-rac-${Date.now()}@welapathkade.test`,
      password: 'AdminPass1!',
      phone: `+9477399${String(++seq).padStart(4, '0')}`,
      name: 'Admin RAC',
    });
    const session = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
    return { token: session.accessToken, adminId: admin.id };
  }

  async function seedCompletedPaidWithReferrals(opts: {
    customerId?: string;
    customerReferrerId: string | null;
    astrologerReferrerId: string | null;
  }) {
    const customer =
      opts.customerId != null
        ? await prisma.user.findUniqueOrThrow({
            where: { id: opts.customerId },
          })
        : await createUser(UserRole.PUBLIC, opts.customerReferrerId);
    const astroUser = await createUser(
      UserRole.ASTROLOGER,
      opts.astrologerReferrerId,
    );
    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astroUser.id,
        displayName: 'RAC Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `RAC_${Date.now()}_${seq}`,
        nameEn: 'RAC',
        nameSi: 'RAC',
        minPrice: 1000,
        maxPrice: 1000,
      },
    });
    const asvc = await prisma.astrologerService.create({
      data: {
        astrologerId: profile.id,
        serviceId: serviceRow.id,
        price: 1000,
      },
    });
    const completedAt = new Date(Date.now() - SETTLEMENT_HOLD_MS - 60_000);
    const startAt = new Date(completedAt.getTime() - 30 * 60_000);
    const consultation = await prisma.consultation.create({
      data: {
        customerId: customer.id,
        astrologerId: profile.id,
        astrologerServiceId: asvc.id,
        serviceId: serviceRow.id,
        serviceNameSi: serviceRow.nameSi,
        serviceNameEn: serviceRow.nameEn,
        status: ConsultationStatus.COMPLETED,
        requestedPrice: 1000,
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
        amount: 1000,
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
        amount: 1000,
        currency: 'LKR',
        status: PaymentStatus.PAID,
        paidAt: new Date(startAt.getTime() - 3_600_000),
      },
    });
    return {
      customerId: customer.id,
      astroUserId: astroUser.id,
      appointmentId: appointment.id,
    };
  }

  it('admin can add, change, and clear attribution with durable audit', async () => {
    const { token, adminId } = await adminToken();
    const referrerA = await createUser(UserRole.PUBLIC);
    const referrerB = await createUser(UserRole.PUBLIC);
    const target = await createUser(UserRole.PUBLIC);

    const added = await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: referrerA.id, reason: 'Add missing referrer' })
      .expect(200);
    const addedBody = bodyOf<CorrectionBody>(added);
    expect(addedBody).toMatchObject({
      userId: target.id,
      referredByUserId: referrerA.id,
      previousReferrerUserId: null,
      reason: 'Add missing referrer',
    });
    expect(addedBody.correctionId).toBeTruthy();
    expect(addedBody.auditLogId).toBeTruthy();

    const correction =
      await prisma.referralAttributionCorrection.findUniqueOrThrow({
        where: { id: addedBody.correctionId },
      });
    expect(correction).toMatchObject({
      targetUserId: target.id,
      previousReferrerUserId: null,
      newReferrerUserId: referrerA.id,
      adminUserId: adminId,
      reason: 'Add missing referrer',
    });
    expect(correction.createdAt).toBeInstanceOf(Date);

    const changed = await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: referrerB.id, reason: 'Fix wrong referrer' })
      .expect(200);
    expect(bodyOf<CorrectionBody>(changed).previousReferrerUserId).toBe(
      referrerA.id,
    );
    expect(bodyOf<CorrectionBody>(changed).referredByUserId).toBe(referrerB.id);

    const cleared = await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: null, reason: 'Remove incorrect attribution' })
      .expect(200);
    expect(bodyOf<CorrectionBody>(cleared).referredByUserId).toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: target.id } }))
        .referredByUserId,
    ).toBeNull();
    expect(await prisma.referralAttributionCorrection.count()).toBe(3);
    expect(await prisma.auditLog.count()).toBe(3);
  });

  it('rejects unauthenticated, non-admin, invalid, cycle, and self-referral requests', async () => {
    const { token } = await adminToken();
    const referrer = await createUser(UserRole.PUBLIC);
    const target = await createUser(UserRole.PUBLIC);
    const astro = await createUser(UserRole.ASTROLOGER);
    const suspended = await createUser(
      UserRole.PUBLIC,
      null,
      UserStatus.SUSPENDED,
    );

    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .send({ referrerUserId: referrer.id, reason: 'no auth' })
      .expect(401);

    await http()
      .post('/auth/otp/request')
      .send({ phone: target.phone, purpose: 'LOGIN' })
      .expect(201);
    const code = authService.getDevOtp(target.phone);
    const publicAuth = await http()
      .post('/auth/otp/verify')
      .send({ phone: target.phone, code })
      .expect(201);
    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set(
        'Authorization',
        `Bearer ${bodyOf<AuthBody>(publicAuth).accessToken}`,
      )
      .send({ referrerUserId: referrer.id, reason: 'not admin' })
      .expect(403);

    await http()
      .patch(`/admin/users/missing-user/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: referrer.id, reason: 'missing target' })
      .expect(404);

    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: 'missing-ref', reason: 'missing referrer' })
      .expect(400);

    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: astro.id, reason: 'astro referrer' })
      .expect(400);

    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: suspended.id, reason: 'suspended' })
      .expect(400);

    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: target.id, reason: 'self' })
      .expect(400);

    await prisma.user.update({
      where: { id: referrer.id },
      data: { referredByUserId: target.id },
    });
    await http()
      .patch(`/admin/users/${target.id}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ referrerUserId: referrer.id, reason: 'direct cycle' })
      .expect(400);
  });

  it('login cannot change an existing referrer', async () => {
    const referrer = await createUser(UserRole.PUBLIC);
    const target = await createUser(UserRole.PUBLIC, referrer.id);
    await http()
      .post('/auth/otp/request')
      .send({ phone: target.phone, purpose: 'LOGIN' })
      .expect(201);
    const code = authService.getDevOtp(target.phone);
    await http()
      .post('/auth/otp/verify')
      .send({
        phone: target.phone,
        code,
        referralCode: 'SOMEONEELSE',
      })
      .expect(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: target.id } }))
        .referredByUserId,
    ).toBe(referrer.id);
  });

  it('concurrent corrections against the same target leave one winner and consistent audit', async () => {
    const { token } = await adminToken();
    const refA = await createUser(UserRole.PUBLIC);
    const refB = await createUser(UserRole.PUBLIC);
    const target = await createUser(UserRole.PUBLIC);

    const results = await Promise.all([
      http()
        .patch(`/admin/users/${target.id}/referral-attribution`)
        .set('Authorization', `Bearer ${token}`)
        .send({ referrerUserId: refA.id, reason: 'Concurrent A' })
        .then((res) => res.status)
        .catch(() => 500),
      http()
        .patch(`/admin/users/${target.id}/referral-attribution`)
        .set('Authorization', `Bearer ${token}`)
        .send({ referrerUserId: refB.id, reason: 'Concurrent B' })
        .then((res) => res.status)
        .catch(() => 500),
    ]);
    expect(
      results.filter((status) => status === 200).length,
    ).toBeGreaterThanOrEqual(1);

    const finalUser = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect([refA.id, refB.id]).toContain(finalUser.referredByUserId);
    const corrections = await prisma.referralAttributionCorrection.findMany({
      where: { targetUserId: target.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    expect(corrections.at(-1)?.newReferrerUserId).toBe(
      finalUser.referredByUserId,
    );
  });

  it('does not rewrite existing snapshots/ledgers; later snapshots use new attribution', async () => {
    const { token } = await adminToken();
    const oldRef = await createUser(UserRole.PUBLIC);
    const newRef = await createUser(UserRole.PUBLIC);
    const ctx = await seedCompletedPaidWithReferrals({
      customerReferrerId: oldRef.id,
      astrologerReferrerId: null,
    });

    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      new Date(),
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.customerReferrerUserId).toBe(oldRef.id);
    expect(snap.snapshot.customerReferralAmount).toBe('30.00');
    await ledger.postSnapshot(snap.snapshot.id, new Date());
    const walletBefore = await ledger.getWalletAvailable(oldRef.id);
    expect(walletBefore.equals(new Prisma.Decimal('30.00'))).toBe(true);

    await http()
      .patch(`/admin/users/${ctx.customerId}/referral-attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        referrerUserId: newRef.id,
        reason: 'Correct customer referrer after settlement',
      })
      .expect(200);

    const snapAfter =
      await prisma.appointmentFinancialSnapshot.findUniqueOrThrow({
        where: { id: snap.snapshot.id },
      });
    expect(snapAfter.customerReferrerUserId).toBe(oldRef.id);
    expect(
      snapAfter.customerReferralAmount.equals(new Prisma.Decimal('30.00')),
    ).toBe(true);
    expect(snapAfter.status).toBe(FinancialSnapshotStatus.POSTED);

    const credits = await prisma.ledgerEntry.findMany({
      where: { snapshotId: snap.snapshot.id, kind: LedgerEntryKind.CREDIT },
    });
    expect(
      credits.find((c) => c.category === LedgerCategory.CUSTOMER_REFERRAL)
        ?.userId,
    ).toBe(oldRef.id);
    expect(
      (await ledger.getWalletAvailable(oldRef.id)).equals(walletBefore),
    ).toBe(true);
    expect(
      (await ledger.getWalletAvailable(newRef.id)).equals(
        new Prisma.Decimal('0'),
      ),
    ).toBe(true);

    // A later eligible appointment for the same customer uses the new referrer.
    const later = await seedCompletedPaidWithReferrals({
      customerId: ctx.customerId,
      customerReferrerId: newRef.id,
      astrologerReferrerId: null,
    });
    const laterSnap = await snapshots.ensureSnapshotForAppointment(
      later.appointmentId,
      new Date(),
    );
    expect(laterSnap.ok).toBe(true);
    if (!laterSnap.ok) return;
    expect(laterSnap.snapshot.customerReferrerUserId).toBe(newRef.id);
    expect(laterSnap.snapshot.customerReferralAmount).toBe('30.00');
  });
});

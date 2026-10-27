import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  ConsultationStatus,
  FinancialSnapshotStatus,
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

describe('Phase D admin finance (e2e)', () => {
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

  async function createUser(role: UserRole = UserRole.PUBLIC) {
    seq += 1;
    return prisma.user.create({
      data: {
        phone: `+94774${String(100000 + seq).padStart(6, '0')}`,
        name: `${role}-${seq}`,
        role,
        status: UserStatus.ACTIVE,
        referralCode: `AF${Date.now()}${seq}`,
      },
    });
  }

  async function adminToken() {
    const admin = await usersService.createAdminUser({
      email: `admin-af-${Date.now()}@welapathkade.test`,
      password: 'AdminPass1!',
      phone: `+9477499${String(++seq).padStart(4, '0')}`,
      name: 'Admin AF',
    });
    const session = await tokenService.issueSession({
      user: admin,
      deviceId: null,
      ip: null,
      userAgent: null,
    });
    return session.accessToken;
  }

  async function seedPostedConsultation() {
    const customer = await createUser(UserRole.PUBLIC);
    const astroUser = await createUser(UserRole.ASTROLOGER);
    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astroUser.id,
        displayName: 'AF Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `AF_${Date.now()}_${seq}`,
        nameEn: 'AF',
        nameSi: 'AF',
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
    const payment = await prisma.payment.create({
      data: {
        appointmentId: appointment.id,
        consultationId: consultation.id,
        amount: 1000,
        currency: 'LKR',
        status: PaymentStatus.PAID,
        paidAt: new Date(startAt.getTime() - 3_600_000),
      },
    });
    const snap = await snapshots.ensureSnapshotForAppointment(
      appointment.id,
      new Date(),
    );
    if (!snap.ok) throw new Error(`snapshot failed: ${snap.reason}`);
    await ledger.postSnapshot(snap.snapshot.id, new Date());
    return {
      customerId: customer.id,
      astroUserId: astroUser.id,
      appointmentId: appointment.id,
      paymentId: payment.id,
      snapshotId: snap.snapshot.id,
    };
  }

  it('rejects unauthenticated and non-admin callers', async () => {
    await http().get('/admin/finance/overview').expect(401);
    const publicUser = await createUser();
    await http()
      .post('/auth/otp/request')
      .send({ phone: publicUser.phone, purpose: 'LOGIN' })
      .expect(201);
    const code = authService.getDevOtp(publicUser.phone);
    const auth = await http()
      .post('/auth/otp/verify')
      .send({ phone: publicUser.phone, code })
      .expect(201);
    await http()
      .get('/admin/finance/overview')
      .set('Authorization', `Bearer ${bodyOf<AuthBody>(auth).accessToken}`)
      .expect(403);
  });

  it('overview and ledger work for admin with posted data', async () => {
    const token = await adminToken();
    const empty = await http()
      .get('/admin/finance/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bodyOf<{ postedGrossAmount: string }>(empty).postedGrossAmount).toBe(
      '0.00',
    );

    const ctx = await seedPostedConsultation();
    const overview = await http()
      .get('/admin/finance/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ov = bodyOf<{
      snapshotsByStatus: { POSTED: { count: number; grossAmount: string } };
      ledgerByCategory: {
        ASTROLOGER_EARNING: { creditAmount: string; netAmount: string };
        PLATFORM_RESIDUAL: { creditAmount: string };
      };
      dateRange: { interval: string };
    }>(overview);
    expect(ov.dateRange.interval).toBe('UTC_HALF_OPEN');
    expect(ov.snapshotsByStatus.POSTED.count).toBe(1);
    expect(ov.snapshotsByStatus.POSTED.grossAmount).toBe('1000.00');
    expect(ov.ledgerByCategory.ASTROLOGER_EARNING.creditAmount).toBe('800.00');
    expect(ov.ledgerByCategory.PLATFORM_RESIDUAL.creditAmount).toBe('200.00');

    await http()
      .get('/admin/finance/overview')
      .query({
        from: '2026-10-02T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    const ledgerList = await http()
      .get('/admin/finance/ledger')
      .query({
        appointmentId: ctx.appointmentId,
        kind: LedgerEntryKind.CREDIT,
        pageSize: 10,
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const list = bodyOf<{
      total: number;
      items: Array<{
        appointmentId: string;
        amount: string;
        category: string;
        passwordHash?: string;
      }>;
    }>(ledgerList);
    expect(list.total).toBe(2);
    expect(list.items.every((i) => i.appointmentId === ctx.appointmentId)).toBe(
      true,
    );
    expect(list.items[0]).not.toHaveProperty('passwordHash');
  });

  it('reconcile is read-only and detects deliberate wallet drift', async () => {
    const token = await adminToken();
    const ctx = await seedPostedConsultation();

    const clean = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const cleanBody = bodyOf<{
      complete: boolean;
      issueCount: number;
      notes: { noMutationsPerformed: boolean };
    }>(clean);
    expect(cleanBody.complete).toBe(true);
    expect(cleanBody.issueCount).toBe(0);
    expect(cleanBody.notes.noMutationsPerformed).toBe(true);

    const beforeEntries = await prisma.ledgerEntry.count();
    const beforeWallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUserId },
    });
    await prisma.walletAccount.update({
      where: { userId: ctx.astroUserId },
      data: { availableBalance: new Prisma.Decimal('1.00') },
    });

    const dirty = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const dirtyBody = bodyOf<{
      issueCount: number;
      issues: Array<{ code: string }>;
    }>(dirty);
    expect(dirtyBody.issueCount).toBeGreaterThanOrEqual(1);
    expect(dirtyBody.issues.map((i) => i.code)).toContain(
      'WALLET_BALANCE_MISMATCH',
    );

    expect(await prisma.ledgerEntry.count()).toBe(beforeEntries);
    const snap = await prisma.appointmentFinancialSnapshot.findUniqueOrThrow({
      where: { id: ctx.snapshotId },
    });
    expect(snap.status).toBe(FinancialSnapshotStatus.POSTED);
    // Restore for cleanup clarity (reconcile must not have repaired it).
    expect(
      (
        await prisma.walletAccount.findUniqueOrThrow({
          where: { userId: ctx.astroUserId },
        })
      ).availableBalance.equals(new Prisma.Decimal('1.00')),
    ).toBe(true);
    expect(
      beforeWallet.availableBalance.equals(new Prisma.Decimal('800.00')),
    ).toBe(true);
  });

  it('lists refund-obligation and manual-review cases only', async () => {
    const token = await adminToken();
    const ctx = await seedPostedConsultation();

    const empty = await http()
      .get('/admin/finance/attention-cases')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bodyOf<{ total: number }>(empty).total).toBe(0);

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: {
        refundObligation: 'FULL_REFUND_DUE',
        refundObligationRecordedAt: new Date(),
      },
    });

    const listed = await http()
      .get('/admin/finance/attention-cases')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = bodyOf<{
      total: number;
      items: Array<{
        appointmentId: string;
        refundObligation: string | null;
        snapshot: { status: string } | null;
        ledger: { hasCredits: boolean };
      }>;
    }>(listed);
    expect(body.total).toBe(1);
    expect(body.items[0].appointmentId).toBe(ctx.appointmentId);
    expect(body.items[0].refundObligation).toBe('FULL_REFUND_DUE');
    expect(body.items[0].snapshot?.status).toBe('POSTED');
    expect(body.items[0].ledger.hasCredits).toBe(true);

    // Listing must not clear flags or mutate ledger.
    const apt = await prisma.appointment.findUniqueOrThrow({
      where: { id: ctx.appointmentId },
    });
    expect(apt.refundObligation).toBe('FULL_REFUND_DUE');
    expect(await prisma.ledgerEntry.count()).toBeGreaterThan(0);
  });
});

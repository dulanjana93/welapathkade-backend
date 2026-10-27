import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ExpirySweepService } from '../src/expiry/expiry-sweep.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { FinancialLedgerService } from '../src/settlement/financial-ledger.service';
import { FinancialSnapshotService } from '../src/settlement/financial-snapshot.service';
import { PLATFORM_ACCOUNT_ID } from '../src/settlement/ledger.constants';
import { SETTLEMENT_HOLD_MS } from '../src/settlement/settlement.constants';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(120_000);

describe('Phase B financial ledger (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let snapshots: FinancialSnapshotService;
  let ledger: FinancialLedgerService;
  let sweep: ExpirySweepService;
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
    snapshots = app.get(FinancialSnapshotService);
    ledger = app.get(FinancialLedgerService);
    sweep = app.get(ExpirySweepService);
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

  async function createUser(role: UserRole, referredByUserId?: string | null) {
    seq += 1;
    return prisma.user.create({
      data: {
        phone: `+94772${String(100000 + seq).padStart(6, '0')}`,
        name: `${role}-${seq}`,
        role,
        referralCode: `LED${Date.now()}${seq}`,
        referredByUserId: referredByUserId ?? null,
      },
    });
  }

  async function seedCompletedPaidAppointment(opts: {
    withCustomerReferrer?: boolean;
    withAstrologerReferrer?: boolean;
    amount?: string;
    completedAt?: Date;
  }) {
    const amount = opts.amount ?? '1000.00';
    const completedAt =
      opts.completedAt ?? new Date(Date.now() - SETTLEMENT_HOLD_MS - 60_000);
    const startAt = new Date(completedAt.getTime() - 30 * 60_000);

    const customerReferrer = opts.withCustomerReferrer
      ? await createUser(UserRole.PUBLIC)
      : null;
    const astrologerReferrer = opts.withAstrologerReferrer
      ? await createUser(UserRole.PUBLIC)
      : null;
    const customer = await createUser(
      UserRole.PUBLIC,
      customerReferrer?.id ?? null,
    );
    const astroUser = await createUser(
      UserRole.ASTROLOGER,
      astrologerReferrer?.id ?? null,
    );

    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astroUser.id,
        displayName: 'Ledger Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
        district: 'Colombo',
        isOnline: true,
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `LED_${Date.now()}_${seq}`,
        nameEn: 'Ledger Service',
        nameSi: 'Ledger Service',
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

    return {
      appointmentId: appointment.id,
      consultationId: consultation.id,
      customerId: customer.id,
      astroUserId: astroUser.id,
      customerReferrerId: customerReferrer?.id ?? null,
      astrologerReferrerId: astrologerReferrer?.id ?? null,
      completedAt,
      amount,
    };
  }

  it('posts both referral commissions and reconciles wallets to ledger', async () => {
    const ctx = await seedCompletedPaidAppointment({
      withCustomerReferrer: true,
      withAstrologerReferrer: true,
    });
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.status).toBe('RECORDED');
    expect(snap.snapshot.astrologerAmount).toBe('800.00');
    expect(snap.snapshot.customerReferralAmount).toBe('30.00');
    expect(snap.snapshot.astrologerReferralAmount).toBe('30.00');
    expect(snap.snapshot.platformAmount).toBe('140.00');

    const posted = await ledger.postSnapshot(snap.snapshot.id, now);
    expect(posted).toEqual(
      expect.objectContaining({ ok: true, posted: true, entryCount: 4 }),
    );

    const entries = await prisma.ledgerEntry.findMany({
      where: { snapshotId: snap.snapshot.id },
    });
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.kind === LedgerEntryKind.CREDIT)).toBe(true);
    expect(
      entries.find((e) => e.category === LedgerCategory.PLATFORM_RESIDUAL)
        ?.userId,
    ).toBeNull();

    const astroWallet = await ledger.getWalletAvailable(ctx.astroUserId);
    const custRefWallet = await ledger.getWalletAvailable(
      ctx.customerReferrerId!,
    );
    const astroRefWallet = await ledger.getWalletAvailable(
      ctx.astrologerReferrerId!,
    );
    const platform = await ledger.getPlatformAvailable();
    expect(astroWallet.equals(new Prisma.Decimal('800.00'))).toBe(true);
    expect(custRefWallet.equals(new Prisma.Decimal('30.00'))).toBe(true);
    expect(astroRefWallet.equals(new Prisma.Decimal('30.00'))).toBe(true);
    expect(platform.equals(new Prisma.Decimal('140.00'))).toBe(true);

    const reconAstro = await ledger.reconcileUserLedger(ctx.astroUserId);
    expect(reconAstro.equals(astroWallet)).toBe(true);

    const snapRow = await prisma.appointmentFinancialSnapshot.findUniqueOrThrow(
      { where: { id: snap.snapshot.id } },
    );
    expect(snapRow.status).toBe(FinancialSnapshotStatus.POSTED);
    expect(snapRow.postedAt).not.toBeNull();
  });

  it('posts customer-referrer-only and astrologer-referrer-only splits', async () => {
    const custOnly = await seedCompletedPaidAppointment({
      withCustomerReferrer: true,
    });
    const now = new Date();
    const snapA = await snapshots.ensureSnapshotForAppointment(
      custOnly.appointmentId,
      now,
    );
    expect(snapA.ok).toBe(true);
    if (!snapA.ok) return;
    expect(snapA.snapshot.platformAmount).toBe('170.00');
    await ledger.postSnapshot(snapA.snapshot.id, now);
    expect(
      (await ledger.getPlatformAvailable()).equals(
        new Prisma.Decimal('170.00'),
      ),
    ).toBe(true);

    await resetE2eDatabase(prisma);

    const astroOnly = await seedCompletedPaidAppointment({
      withAstrologerReferrer: true,
    });
    const snapB = await snapshots.ensureSnapshotForAppointment(
      astroOnly.appointmentId,
      now,
    );
    expect(snapB.ok).toBe(true);
    if (!snapB.ok) return;
    expect(snapB.snapshot.platformAmount).toBe('170.00');
    await ledger.postSnapshot(snapB.snapshot.id, now);
    const categories = (
      await prisma.ledgerEntry.findMany({
        where: { snapshotId: snapB.snapshot.id },
      })
    ).map((e) => e.category);
    expect(categories).toContain(LedgerCategory.ASTROLOGER_REFERRAL);
    expect(categories).not.toContain(LedgerCategory.CUSTOMER_REFERRAL);
  });

  it('posts no-referral residual only to platform account', async () => {
    const ctx = await seedCompletedPaidAppointment({});
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.platformAmount).toBe('200.00');
    await ledger.postSnapshot(snap.snapshot.id, now);

    const platformEntry = await prisma.ledgerEntry.findFirstOrThrow({
      where: {
        snapshotId: snap.snapshot.id,
        category: LedgerCategory.PLATFORM_RESIDUAL,
      },
    });
    expect(platformEntry.userId).toBeNull();
    expect(
      await prisma.walletAccount.count({ where: { userId: ctx.customerId } }),
    ).toBe(0);
    expect(
      (await ledger.getPlatformAvailable()).equals(
        new Prisma.Decimal('200.00'),
      ),
    ).toBe(true);
    const platformRow = await prisma.platformAccount.findUniqueOrThrow({
      where: { id: PLATFORM_ACCOUNT_ID },
    });
    expect(
      platformRow.availableBalance.equals(new Prisma.Decimal('200.00')),
    ).toBe(true);
  });

  it('does not create a snapshot or post while settlement hold is active', async () => {
    const ctx = await seedCompletedPaidAppointment({
      completedAt: new Date(),
    });

    const early = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      new Date(),
    );
    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.reason).toBe('SETTLEMENT_HOLD_ACTIVE');

    const posted = await ledger.postDueSnapshots(new Date());
    expect(posted.posted).toBe(0);
  });

  it('rechecks hold and refund blockers under lock before posting a RECORDED snapshot', async () => {
    const ctx = await seedCompletedPaidAppointment({});
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    await prisma.appointmentFinancialSnapshot.update({
      where: { id: snap.snapshot.id },
      data: { holdExpiresAt: new Date(now.getTime() + 60_000) },
    });
    expect(await ledger.postSnapshot(snap.snapshot.id, now)).toEqual({
      ok: false,
      reason: 'SETTLEMENT_HOLD_ACTIVE',
    });
    expect(await prisma.ledgerEntry.count()).toBe(0);

    await prisma.appointmentFinancialSnapshot.update({
      where: { id: snap.snapshot.id },
      data: { holdExpiresAt: new Date(now.getTime() - 1000) },
    });
    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    expect(await ledger.postSnapshot(snap.snapshot.id, now)).toEqual({
      ok: false,
      reason: 'APPOINTMENT_BLOCKS_POSTING',
    });
    expect(await prisma.ledgerEntry.count()).toBe(0);
    expect(
      (
        await prisma.appointmentFinancialSnapshot.findUniqueOrThrow({
          where: { id: snap.snapshot.id },
        })
      ).status,
    ).toBe(FinancialSnapshotStatus.RECORDED);
  });

  it('refuses to mark POSTED when a partial credit set already exists', async () => {
    const ctx = await seedCompletedPaidAppointment({});
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    await prisma.ledgerEntry.create({
      data: {
        idempotencyKey: `snap:${snap.snapshot.id}:ASTROLOGER_EARNING:CREDIT`,
        category: LedgerCategory.ASTROLOGER_EARNING,
        kind: LedgerEntryKind.CREDIT,
        amount: new Prisma.Decimal('800.00'),
        currency: 'LKR',
        userId: ctx.astroUserId,
        appointmentId: ctx.appointmentId,
        consultationId: ctx.consultationId,
        paymentId: (
          await prisma.payment.findFirstOrThrow({
            where: { appointmentId: ctx.appointmentId },
          })
        ).id,
        snapshotId: snap.snapshot.id,
      },
    });

    expect(await ledger.postSnapshot(snap.snapshot.id, now)).toEqual({
      ok: false,
      reason: 'INCOMPLETE_LEDGER',
    });
    expect(
      (
        await prisma.appointmentFinancialSnapshot.findUniqueOrThrow({
          where: { id: snap.snapshot.id },
        })
      ).status,
    ).toBe(FinancialSnapshotStatus.RECORDED);
    expect(await prisma.walletAccount.count()).toBe(0);
  });

  it('repeated sweep and concurrent posts never double-credit', async () => {
    const ctx = await seedCompletedPaidAppointment({
      withCustomerReferrer: true,
    });
    const now = new Date();
    const firstSweep = await sweep.runOnce(now);
    expect(firstSweep.financialSnapshotsCreated).toBeGreaterThanOrEqual(1);
    expect(firstSweep.financialLedgersPosted).toBeGreaterThanOrEqual(1);

    const snap = await prisma.appointmentFinancialSnapshot.findUniqueOrThrow({
      where: { appointmentId: ctx.appointmentId },
    });
    const [a, b] = await Promise.all([
      ledger.postSnapshot(snap.id, now),
      ledger.postSnapshot(snap.id, now),
    ]);
    expect(a.ok && a.posted === false).toBe(true);
    expect(b.ok && b.posted === false).toBe(true);

    const secondSweep = await sweep.runOnce(now);
    expect(secondSweep.financialSnapshotsCreated).toBe(0);
    expect(secondSweep.financialLedgersPosted).toBe(0);

    const credits = await prisma.ledgerEntry.findMany({
      where: { snapshotId: snap.id, kind: LedgerEntryKind.CREDIT },
    });
    expect(credits).toHaveLength(3);
    expect(
      (await ledger.getWalletAvailable(ctx.astroUserId)).equals(
        new Prisma.Decimal('800.00'),
      ),
    ).toBe(true);
  });

  it('blocks posting when refund obligation or manual review is pending', async () => {
    const ctx = await seedCompletedPaidAppointment({});
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    expect(await ledger.postSnapshot(snap.snapshot.id, now)).toEqual({
      ok: false,
      reason: 'APPOINTMENT_BLOCKS_POSTING',
    });

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: {
        refundObligation: null,
        manualReviewRequired: true,
      },
    });
    expect(await ledger.postSnapshot(snap.snapshot.id, now)).toEqual({
      ok: false,
      reason: 'APPOINTMENT_BLOCKS_POSTING',
    });
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it('does not reverse unposted snapshots; reverses posted ones idempotently', async () => {
    const ctx = await seedCompletedPaidAppointment({});
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    expect(
      await ledger.reversePostedSnapshotForRefundObligation(
        ctx.appointmentId,
        now,
      ),
    ).toEqual({ ok: false, reason: 'NOT_POSTED' });

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: null },
    });
    await ledger.postSnapshot(snap.snapshot.id, now);
    expect(
      (await ledger.getWalletAvailable(ctx.astroUserId)).equals(
        new Prisma.Decimal('800.00'),
      ),
    ).toBe(true);

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    const reversed = await ledger.reversePostedSnapshotForRefundObligation(
      ctx.appointmentId,
      now,
    );
    expect(reversed).toEqual(
      expect.objectContaining({ ok: true, reversed: true }),
    );

    const originalCredits = await prisma.ledgerEntry.findMany({
      where: { snapshotId: snap.snapshot.id, kind: LedgerEntryKind.CREDIT },
    });
    const debits = await prisma.ledgerEntry.findMany({
      where: { snapshotId: snap.snapshot.id, kind: LedgerEntryKind.DEBIT },
    });
    expect(originalCredits).toHaveLength(2);
    expect(debits).toHaveLength(2);
    expect(debits.every((d) => d.reversesEntryId != null)).toBe(true);
    expect(
      (await ledger.getWalletAvailable(ctx.astroUserId)).equals(
        new Prisma.Decimal('0.00'),
      ),
    ).toBe(true);

    const again = await ledger.reversePostedSnapshotForRefundObligation(
      ctx.appointmentId,
      now,
    );
    expect(again).toEqual(
      expect.objectContaining({ ok: true, reversed: false }),
    );
    expect(
      await prisma.ledgerEntry.count({
        where: { snapshotId: snap.snapshot.id, kind: LedgerEntryKind.DEBIT },
      }),
    ).toBe(2);

    const payment = await prisma.payment.findFirst({
      where: { appointmentId: ctx.appointmentId },
    });
    expect(payment?.status).toBe(PaymentStatus.PAID);
  });

  it('no-show / both-absent outcomes never create snapshots or ledger credits', async () => {
    for (const status of [
      AppointmentStatus.NO_SHOW_CUSTOMER,
      AppointmentStatus.NO_SHOW_ASTROLOGER,
      AppointmentStatus.NO_SHOW_BOTH,
    ] as const) {
      await resetE2eDatabase(prisma);
      const ctx = await seedCompletedPaidAppointment({});
      await prisma.appointment.update({
        where: { id: ctx.appointmentId },
        data: {
          status,
          refundObligation:
            status === AppointmentStatus.NO_SHOW_CUSTOMER
              ? null
              : 'FULL_REFUND_DUE',
          manualReviewRequired: status === AppointmentStatus.NO_SHOW_CUSTOMER,
        },
      });
      const snap = await snapshots.ensureSnapshotForAppointment(
        ctx.appointmentId,
        new Date(),
      );
      expect(snap.ok).toBe(false);
      expect(await prisma.appointmentFinancialSnapshot.count()).toBe(0);
      expect(await prisma.ledgerEntry.count()).toBe(0);
    }
  });

  it('mid-post failure leaves no partial ledger rows (transaction rollback)', async () => {
    const ctx = await seedCompletedPaidAppointment({});
    const now = new Date();
    const snap = await snapshots.ensureSnapshotForAppointment(
      ctx.appointmentId,
      now,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const spy = jest
      .spyOn(
        ledger as unknown as {
          creditBalance: (...args: unknown[]) => Promise<void>;
        },
        'creditBalance',
      )
      .mockRejectedValueOnce(new Error('forced wallet failure'));

    await expect(ledger.postSnapshot(snap.snapshot.id, now)).rejects.toThrow(
      'forced wallet failure',
    );
    spy.mockRestore();

    expect(await prisma.ledgerEntry.count()).toBe(0);
    const row = await prisma.appointmentFinancialSnapshot.findUniqueOrThrow({
      where: { id: snap.snapshot.id },
    });
    expect(row.status).toBe(FinancialSnapshotStatus.RECORDED);
    expect(await prisma.walletAccount.count()).toBe(0);

    const retry = await ledger.postSnapshot(snap.snapshot.id, now);
    expect(retry).toEqual(expect.objectContaining({ ok: true, posted: true }));
  });
});

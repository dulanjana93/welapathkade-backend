import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  ConsultationStatus,
  PaymentStatus,
  Prisma,
  UserRole,
  UserStatus,
  WithdrawalStatus,
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

jest.setTimeout(180_000);

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

function messageOf(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = body.message;
    return Array.isArray(message) ? message.join(' ') : String(message);
  }
  return '';
}

describe('Customer referral payouts (e2e)', () => {
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

  async function createUser(role: UserRole) {
    seq += 1;
    return prisma.user.create({
      data: {
        phone: `+94775${String(100000 + seq).padStart(6, '0')}`,
        name: `${role}-rp-${seq}`,
        role,
        status: UserStatus.ACTIVE,
        referralCode: `RP${Date.now()}${seq}`,
      },
    });
  }

  async function tokenFor(user: User) {
    const session = await tokenService.issueSession({
      user,
      deviceId: null,
      ip: null,
      userAgent: 'referral-payout-e2e',
    });
    return session.accessToken;
  }

  async function adminToken() {
    const admin = await usersService.createAdminUser({
      email: `admin-rp-${Date.now()}-${++seq}@welapathkade.test`,
      password: 'AdminPass1!',
      phone: `+9477599${String(seq).padStart(4, '0')}`,
      name: 'Admin RP',
    });
    return { admin, token: await tokenFor(admin) };
  }

  /** Gross 50000 yields a 3% customer referral credit of LKR 1500. */
  async function seedReferral() {
    const referrer = await createUser(UserRole.PUBLIC);
    const customer = await createUser(UserRole.PUBLIC);
    await prisma.user.update({
      where: { id: customer.id },
      data: { referredByUserId: referrer.id },
    });
    const astroUser = await createUser(UserRole.ASTROLOGER);
    const gross = '50000.00';
    const startAt = new Date(Date.now() - 48 * 3_600_000);
    const completedAt = new Date(startAt.getTime() + 30 * 60_000);
    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astroUser.id,
        displayName: 'Referral Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
        district: 'Colombo',
        isOnline: true,
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `RP_${Date.now()}_${seq}`,
        nameEn: 'Referral Service',
        nameSi: 'Referral Service',
        minPrice: new Prisma.Decimal(gross),
        maxPrice: new Prisma.Decimal(gross),
      },
    });
    const asvc = await prisma.astrologerService.create({
      data: {
        astrologerId: profile.id,
        serviceId: serviceRow.id,
        price: new Prisma.Decimal(gross),
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
        requestedPrice: new Prisma.Decimal(gross),
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
        amount: new Prisma.Decimal(gross),
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
        amount: new Prisma.Decimal(gross),
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
    if (!snap.ok) throw new Error(`snapshot failed: ${snap.reason}`);
    const posted = await ledger.postSnapshot(snap.snapshot.id, now);
    if (!posted.ok) throw new Error(`post failed: ${posted.reason}`);
    return {
      referrer,
      token: await tokenFor(referrer),
      astroToken: await tokenFor(astroUser),
      appointmentId: appointment.id,
    };
  }

  async function addBank(token: string, accountNumber = '123456789012') {
    const res = await http()
      .post('/me/referral-payouts/bank-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'Commercial Bank',
        accountHolderName: 'Referrer Name',
        branchName: 'Kandy',
        bankCode: '7056',
        branchCode: '001',
        accountNumber,
      })
      .expect(201);
    return bodyOf<{ id: string; accountNumberMasked: string }>(res);
  }

  async function requestPayout(
    token: string,
    bankAccountId: string,
    amount = '1000.00',
  ) {
    return http()
      .post('/me/referral-payouts')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount, bankAccountId });
  }

  it('pays only customer referral earnings and hides full account numbers', async () => {
    const ctx = await seedReferral();
    const fullNumber = '123456789012';
    const { token: adminBearer } = await adminToken();
    const other = await createUser(UserRole.PUBLIC);
    const otherToken = await tokenFor(other);

    const summary = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ eligibleAmount: string; withdrawableAmount: string }>(summary),
    ).toEqual(
      expect.objectContaining({
        eligibleAmount: '1500.00',
        reservedAmount: '0.00',
        withdrawableAmount: '1500.00',
        minimumAmount: '1000.00',
        canRequest: false,
        blockedReason: 'NO_BANK_ACCOUNT',
      }),
    );

    await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.astroToken}`)
      .expect(403);
    await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: 'none' })
      .expect(403);

    const bank = await addBank(ctx.token, fullNumber);
    expect(bank.accountNumberMasked).toBe('••••9012');
    expect(JSON.stringify(bank)).not.toContain(fullNumber);

    await http()
      .get('/me/referral-payouts/bank-accounts')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual([]);
      });

    const below = await requestPayout(ctx.token, bank.id, '999.99');
    expect(below.status).toBe(400);
    expect(messageOf(below.body)).toContain('WITHDRAWAL_BELOW_MINIMUM');

    const spoofed = await http()
      .post('/me/referral-payouts')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({
        amount: '1000.00',
        bankAccountId: bank.id,
        userId: other.id,
      });
    expect(spoofed.status).toBe(400);

    await prisma.walletAccount.update({
      where: { userId: ctx.referrer.id },
      data: { availableBalance: new Prisma.Decimal('8000.00') },
    });
    const capped = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ withdrawableAmount: string }>(capped).withdrawableAmount,
    ).toBe('1500.00');
    await prisma.walletAccount.update({
      where: { userId: ctx.referrer.id },
      data: { availableBalance: new Prisma.Decimal('1500.00') },
    });

    const created = await requestPayout(ctx.token, bank.id, '1000.00');
    expect(created.status).toBe(201);
    const id = bodyOf<{ id: string; purpose: string }>(created).id;
    expect(bodyOf<{ purpose: string }>(created).purpose).toBe(
      'CUSTOMER_REFERRAL',
    );
    expect(JSON.stringify(created.body)).not.toContain(fullNumber);

    const reserved = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string; withdrawableAmount: string }>(reserved),
    ).toEqual(
      expect.objectContaining({
        reservedAmount: '1000.00',
        withdrawableAmount: '500.00',
      }),
    );

    const again = await requestPayout(ctx.token, bank.id, '1000.00');
    expect(again.status).toBe(400);
    expect(messageOf(again.body)).toContain('WITHDRAWAL_INSUFFICIENT_FUNDS');

    await http()
      .get(`/me/referral-payouts/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    const ledgerBefore = await prisma.ledgerEntry.count();
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);
    const stillReserved = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string }>(stillReserved).reservedAmount,
    ).toBe('1000.00');
    expect(await prisma.withdrawalDebit.count()).toBe(0);

    const paid = await http()
      .post(`/admin/finance/withdrawals/${id}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'REF-PAY-1',
        actualTransferredAt: '2026-10-20T10:00:00.000Z',
      })
      .expect(201);
    expect(bodyOf<{ status: string; transferReference: string }>(paid)).toEqual(
      expect.objectContaining({
        status: 'PAID',
        transferReference: 'REF-PAY-1',
      }),
    );
    expect(await prisma.withdrawalDebit.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(ledgerBefore);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.referrer.id },
    });
    expect(wallet.availableBalance.toFixed(2)).toBe('500.00');
    expect(
      await prisma.auditLog.count({
        where: { entityId: id, action: 'WITHDRAWAL_PAID' },
      }),
    ).toBe(1);

    const hidden = await http()
      .get('/admin/finance/withdrawals')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(
      bodyOf<{ items: Array<{ id: string }> }>(hidden).items.map(
        (item) => item.id,
      ),
    ).not.toContain(id);
    const listed = await http()
      .get('/admin/finance/withdrawals')
      .query({ purpose: 'CUSTOMER_REFERRAL' })
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(
      bodyOf<{ items: Array<{ id: string }> }>(listed).items.map(
        (item) => item.id,
      ),
    ).toContain(id);
    const listedRow = bodyOf<{
      items: Array<{
        id: string;
        customerName?: string;
        beneficiaryName?: string;
        astrologerName?: string;
      }>;
    }>(listed).items.find((item) => item.id === id);
    expect(listedRow).toEqual(
      expect.objectContaining({
        customerName: ctx.referrer.name,
        beneficiaryName: ctx.referrer.name,
      }),
    );
    expect(listedRow).not.toHaveProperty('astrologerName');
    const detail = await http()
      .get(`/admin/finance/withdrawals/${id}`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(
      bodyOf<{ customerName: string; beneficiaryName: string }>(detail),
    ).toEqual(
      expect.objectContaining({
        customerName: ctx.referrer.name,
        beneficiaryName: ctx.referrer.name,
      }),
    );
    expect(detail.body).not.toHaveProperty('astrologerName');

    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(403);
  });

  it('rejects a pending payout once and releases the reservation', async () => {
    const ctx = await seedReferral();
    const { token: adminBearer } = await adminToken();
    const bank = await addBank(ctx.token);
    const created = await requestPayout(ctx.token, bank.id);
    expect(created.status).toBe(201);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/reject`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Details do not match' })
      .expect(201);
    const again = await http()
      .post(`/admin/finance/withdrawals/${id}/reject`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Details do not match' });
    expect(again.status).toBe(409);
    const summary = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(bodyOf<{ reservedAmount: string }>(summary).reservedAmount).toBe(
      '0.00',
    );
    expect(await prisma.withdrawalDebit.count()).toBe(0);
    const detail = await http()
      .get(`/me/referral-payouts/${id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(bodyOf<{ rejectionReason: string }>(detail).rejectionReason).toBe(
      'Details do not match',
    );
  });

  it('lets an admin cancel an approved payout without a debit', async () => {
    const ctx = await seedReferral();
    const { admin, token: adminBearer } = await adminToken();
    const bank = await addBank(ctx.token);
    const created = await requestPayout(ctx.token, bank.id);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);
    await http()
      .post(`/me/referral-payouts/${id}/cancel`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ reason: 'Customer must not cancel' })
      .expect(404);
    await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Cannot complete this transfer' })
      .expect(201);
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
      include: { debit: true },
    });
    expect(row.status).toBe(WithdrawalStatus.CANCELLED);
    expect(row.cancelledByAdminId).toBe(admin.id);
    expect(row.debit).toBeNull();
    const summary = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string; withdrawableAmount: string }>(summary),
    ).toEqual(
      expect.objectContaining({
        reservedAmount: '0.00',
        withdrawableAmount: '1500.00',
      }),
    );
  });

  it('serializes concurrent requests and conflicting admin transitions', async () => {
    const ctx = await seedReferral();
    const { token: adminBearer } = await adminToken();
    const bank = await addBank(ctx.token);
    const [first, second] = await Promise.all([
      requestPayout(ctx.token, bank.id, '1000.00'),
      requestPayout(ctx.token, bank.id, '1000.00'),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);
    expect(await prisma.withdrawalRequest.count()).toBe(1);

    const pending = await requestPayout(ctx.token, bank.id, '500.00');
    expect(pending.status).toBe(400);

    const id = bodyOf<{ id: string }>(first.status === 201 ? first : second).id;
    const [approved, rejected] = await Promise.all([
      http()
        .post(`/admin/finance/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminBearer}`),
      http()
        .post(`/admin/finance/withdrawals/${id}/reject`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({ reason: 'Race reject' }),
    ]);
    expect([approved.status, rejected.status].sort()).toEqual([201, 409]);
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect([WithdrawalStatus.APPROVED, WithdrawalStatus.REJECTED]).toContain(
      row.status,
    );

    if (row.status === WithdrawalStatus.REJECTED) {
      const replacement = await requestPayout(ctx.token, bank.id, '1000.00');
      expect(replacement.status).toBe(201);
      await http()
        .post(
          `/admin/finance/withdrawals/${bodyOf<{ id: string }>(replacement).id}/approve`,
        )
        .set('Authorization', `Bearer ${adminBearer}`)
        .expect(201);
    }
    const payable = await prisma.withdrawalRequest.findFirstOrThrow({
      where: { userId: ctx.referrer.id, status: WithdrawalStatus.APPROVED },
    });
    const [payA, payB] = await Promise.all([
      http()
        .post(`/admin/finance/withdrawals/${payable.id}/mark-paid`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({
          transferReference: 'RACE-A',
          actualTransferredAt: '2026-10-20T10:00:00.000Z',
        }),
      http()
        .post(`/admin/finance/withdrawals/${payable.id}/mark-paid`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({
          transferReference: 'RACE-B',
          actualTransferredAt: '2026-10-20T10:00:00.000Z',
        }),
    ]);
    expect([payA.status, payB.status].sort()).toEqual([201, 409]);
    expect(await prisma.withdrawalDebit.count()).toBe(1);
  });

  it('blocks payment after a referral reversal and does not repair history', async () => {
    const ctx = await seedReferral();
    const { token: adminBearer } = await adminToken();
    const bank = await addBank(ctx.token);
    const created = await requestPayout(ctx.token, bank.id);
    const id = bodyOf<{ id: string }>(created).id;
    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    const reversed = await ledger.reversePostedSnapshotForRefundObligation(
      ctx.appointmentId,
    );
    expect(reversed.ok).toBe(true);
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);
    const paid = await http()
      .post(`/admin/finance/withdrawals/${id}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'AFTER-REVERSAL',
        actualTransferredAt: '2026-10-20T10:00:00.000Z',
      });
    expect(paid.status).toBe(409);
    expect(await prisma.withdrawalDebit.count()).toBe(0);
    const referralDebits = await prisma.ledgerEntry.count({
      where: {
        userId: ctx.referrer.id,
        category: 'CUSTOMER_REFERRAL',
        kind: 'DEBIT',
      },
    });
    expect(referralDebits).toBe(1);
    const recon = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    const codes = bodyOf<{ issues: Array<{ code: string }> }>(recon).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'WITHDRAWAL_RESERVATION_EXCEEDS_WALLET',
        'CUSTOMER_PAYOUT_RESERVATION_EXCEEDS_ELIGIBLE',
        'CUSTOMER_PAYOUT_UNPAYABLE',
      ]),
    );
    const unpayable = bodyOf<{
      issues: Array<{
        code: string;
        references: {
          withdrawalId: string;
          beneficiaryName: string;
          beneficiaryUserId: string;
          amount: string;
          shortfallAmount: string;
        };
      }>;
    }>(recon).issues.find(
      (issue) => issue.code === 'CUSTOMER_PAYOUT_UNPAYABLE',
    );
    expect(unpayable?.references).toEqual({
      withdrawalId: id,
      beneficiaryUserId: ctx.referrer.id,
      beneficiaryName: ctx.referrer.name,
      amount: '1000.00',
      shortfallAmount: '1000.00',
    });
    const untouched = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(untouched.status).toBe(WithdrawalStatus.APPROVED);

    const cancelled = await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Referral reversal made this payout unpayable' })
      .expect(201);
    expect(
      bodyOf<{ status: string; cancellationReason: string }>(cancelled),
    ).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        cancellationReason: 'Referral reversal made this payout unpayable',
      }),
    );
    const secondCancel = await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Referral reversal made this payout unpayable' });
    expect(secondCancel.status).toBe(409);
    expect(await prisma.withdrawalDebit.count()).toBe(0);
    const released = await http()
      .get('/me/referral-payouts/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(bodyOf<{ reservedAmount: string }>(released).reservedAmount).toBe(
      '0.00',
    );
    expect(
      await prisma.auditLog.count({
        where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
      }),
    ).toBe(1);
    const after = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    const afterCodes = bodyOf<{ issues: Array<{ code: string }> }>(
      after,
    ).issues.map((issue) => issue.code);
    expect(afterCodes).not.toContain('CUSTOMER_PAYOUT_UNPAYABLE');
    expect(afterCodes).not.toContain(
      'CUSTOMER_PAYOUT_RESERVATION_EXCEEDS_ELIGIBLE',
    );
  });

  it('lets exactly one of cancel and mark-paid commit for a customer payout', async () => {
    const ctx = await seedReferral();
    const { token: adminBearer } = await adminToken();
    const bank = await addBank(ctx.token);
    const created = await requestPayout(ctx.token, bank.id);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);

    const [cancelled, paid] = await Promise.all([
      http()
        .post(`/admin/finance/withdrawals/${id}/cancel`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({ reason: 'Racing the manual transfer' }),
      http()
        .post(`/admin/finance/withdrawals/${id}/mark-paid`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({
          transferReference: 'RACE-CANCEL-PAY',
          actualTransferredAt: '2026-10-20T10:00:00.000Z',
        }),
    ]);
    expect([cancelled.status, paid.status].sort()).toEqual([201, 409]);
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
      include: { debit: true },
    });
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.referrer.id },
    });
    if (row.status === WithdrawalStatus.CANCELLED) {
      expect(row.debit).toBeNull();
      expect(wallet.availableBalance.toFixed(2)).toBe('1500.00');
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'WITHDRAWAL_PAID' },
        }),
      ).toBe(0);
    } else {
      expect(row.status).toBe(WithdrawalStatus.PAID);
      expect(row.debit?.amount.toFixed(2)).toBe('1000.00');
      expect(wallet.availableBalance.toFixed(2)).toBe('500.00');
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'WITHDRAWAL_PAID' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
        }),
      ).toBe(0);
    }
    expect(await prisma.withdrawalDebit.count()).toBe(
      row.status === WithdrawalStatus.PAID ? 1 : 0,
    );
  });
});

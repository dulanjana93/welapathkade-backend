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
import { WithdrawalsService } from '../src/withdrawals/withdrawals.service';
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

describe('Astrologer withdrawals (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokenService: TokenService;
  let usersService: UsersService;
  let snapshots: FinancialSnapshotService;
  let ledger: FinancialLedgerService;
  let withdrawals: WithdrawalsService;
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
    withdrawals = app.get(WithdrawalsService);
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
        phone: `+94776${String(100000 + seq).padStart(6, '0')}`,
        name: `${role}-wd-${seq}`,
        role,
        status: UserStatus.ACTIVE,
        referralCode: `WD${Date.now()}${seq}`,
      },
    });
  }

  async function tokenFor(user: User) {
    const session = await tokenService.issueSession({
      user,
      deviceId: null,
      ip: null,
      userAgent: 'withdrawal-e2e',
    });
    return session.accessToken;
  }

  async function adminToken() {
    const admin = await usersService.createAdminUser({
      email: `admin-wd-${Date.now()}-${++seq}@welapathkade.test`,
      password: 'AdminPass1!',
      phone: `+9477699${String(seq).padStart(4, '0')}`,
      name: 'Admin WD',
    });
    return { admin, token: await tokenFor(admin) };
  }

  async function seedEarning(gross: string) {
    const customer = await createUser(UserRole.PUBLIC);
    const astroUser = await createUser(UserRole.ASTROLOGER);
    const startAt = new Date(Date.now() - 48 * 3_600_000);
    const completedAt = new Date(startAt.getTime() + 30 * 60_000);
    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astroUser.id,
        displayName: 'Withdraw Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
        district: 'Colombo',
        isOnline: true,
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `WD_${Date.now()}_${seq}`,
        nameEn: 'Withdraw Service',
        nameSi: 'Withdraw Service',
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
      astroUser,
      token: await tokenFor(astroUser),
      appointmentId: appointment.id,
    };
  }

  async function addBank(token: string, accountNumber = '123456789012') {
    const res = await http()
      .post('/astrologers/me/bank-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'Commercial Bank',
        accountHolderName: 'Test Astrologer',
        branchName: 'Colombo',
        bankCode: '7056',
        branchCode: '001',
        accountNumber,
      })
      .expect(201);
    return bodyOf<{ id: string; accountNumberMasked: string }>(res);
  }

  it('enforces minimum, currency, bank account, masking, and insufficient funds', async () => {
    const ctx = await seedEarning('1250.00');
    const fullNumber = '123456789012';
    const bank = await addBank(ctx.token, fullNumber);
    expect(bank.accountNumberMasked).toBe('••••9012');
    expect(JSON.stringify(bank)).not.toContain(fullNumber);

    const below = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '999.99', bankAccountId: bank.id, currency: 'LKR' });
    expect(below.status).toBe(400);
    expect(messageOf(below.body)).toContain('WITHDRAWAL_BELOW_MINIMUM');

    await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.001', bankAccountId: bank.id })
      .expect(400);

    await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id, currency: 'USD' })
      .expect(400);

    const poor = await seedEarning('1000.00');
    const poorBank = await addBank(poor.token, '5555555555');
    const short = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${poor.token}`)
      .send({ amount: '1000.00', bankAccountId: poorBank.id });
    expect(short.status).toBe(400);
    expect(messageOf(short.body)).toContain('WITHDRAWAL_INSUFFICIENT_FUNDS');

    const noBank = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: 'missing-account' });
    expect(noBank.status).toBe(400);
    expect(messageOf(noBank.body)).toContain('BANK_ACCOUNT_REQUIRED');

    await http()
      .patch(`/astrologers/me/bank-accounts/${bank.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ isActive: false })
      .expect(200);
    const inactive = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id });
    expect(messageOf(inactive.body)).toContain('BANK_ACCOUNT_INACTIVE');
    expect(await prisma.withdrawalRequest.count()).toBe(0);
  });

  it('reserves once, rejects once, approves without debit, and pays exactly once', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { admin, token: adminBearer } = await adminToken();
    const ledgerBefore = await prisma.ledgerEntry.count();

    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .set('Idempotency-Key', 'withdraw-once-01')
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const withdrawal = bodyOf<{
      id: string;
      status: string;
      destination: { accountNumberMasked: string };
    }>(created);
    expect(withdrawal.status).toBe(WithdrawalStatus.PENDING_REVIEW);
    expect(withdrawal.destination.accountNumberMasked).toBe('••••9012');

    const replay = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .set('Idempotency-Key', 'withdraw-once-01')
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    expect(bodyOf<{ id: string }>(replay).id).toBe(withdrawal.id);

    const conflict = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .set('Idempotency-Key', 'withdraw-once-01')
      .send({ amount: '1500.00', bankAccountId: bank.id });
    expect(conflict.status).toBe(409);

    const summary = await http()
      .get('/astrologers/me/withdrawals/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    const funds = bodyOf<{
      availableBalance: string;
      reservedAmount: string;
      withdrawableAmount: string;
    }>(summary);
    expect(funds.availableBalance).toBe('2000.00');
    expect(funds.reservedAmount).toBe('1000.00');
    expect(funds.withdrawableAmount).toBe('1000.00');

    await http()
      .patch(`/astrologers/me/bank-accounts/${bank.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ accountNumber: '999988887777' })
      .expect(200);
    const detail = await http()
      .get(`/astrologers/me/withdrawals/${withdrawal.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ destination: { accountNumberMasked: string } }>(detail)
        .destination.accountNumberMasked,
    ).toBe('••••9012');
    expect(JSON.stringify(detail.body)).not.toContain('123456789012');
    expect(JSON.stringify(detail.body)).not.toContain('999988887777');

    const walletBeforeApprove = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    const approved = await http()
      .post(`/admin/finance/withdrawals/${withdrawal.id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);
    expect(bodyOf<{ status: string }>(approved).status).toBe('APPROVED');
    const walletAfterApprove = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(walletAfterApprove.availableBalance.toFixed(2)).toBe(
      walletBeforeApprove.availableBalance.toFixed(2),
    );
    expect(await prisma.withdrawalDebit.count()).toBe(0);

    await http()
      .post(`/admin/finance/withdrawals/${withdrawal.id}/reject`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'too late' })
      .expect(409);

    const paid = await http()
      .post(`/admin/finance/withdrawals/${withdrawal.id}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'BANK-REF-1001',
        actualTransferredAt: new Date().toISOString(),
      })
      .expect(201);
    expect(
      bodyOf<{ status: string; transferReference: string }>(paid).status,
    ).toBe('PAID');
    expect(
      await prisma.withdrawalDebit.count({
        where: { withdrawalRequestId: withdrawal.id },
      }),
    ).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(ledgerBefore);
    const walletPaid = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(walletPaid.availableBalance.toFixed(2)).toBe('1000.00');

    await http()
      .post(`/admin/finance/withdrawals/${withdrawal.id}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'BANK-REF-1002',
        actualTransferredAt: new Date().toISOString(),
      })
      .expect(409);
    expect(await prisma.withdrawalDebit.count()).toBe(1);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: withdrawal.id },
    });
    expect(audit.map((row) => row.action).sort()).toEqual([
      'WITHDRAWAL_APPROVED',
      'WITHDRAWAL_PAID',
    ]);
    expect(JSON.stringify(audit)).not.toContain('123456789012');

    const adminView = await http()
      .get(`/admin/finance/withdrawals/${withdrawal.id}`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(JSON.stringify(adminView.body)).not.toContain('123456789012');
    expect(admin.id).toBeTruthy();

    const recon = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    const issues = bodyOf<{ issues: Array<{ code: string }> }>(recon).issues;
    expect(issues.map((issue) => issue.code)).not.toContain(
      'WALLET_BALANCE_MISMATCH',
    );
    expect(issues.map((issue) => issue.code)).not.toContain(
      'PAID_WITHDRAWAL_MISSING_DEBIT',
    );
  });

  it('releases a reservation exactly once and keeps approval distinct from payment', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;

    await http()
      .post(`/admin/finance/withdrawals/${id}/reject`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Name mismatch' })
      .expect(201);
    const again = await http()
      .post(`/admin/finance/withdrawals/${id}/reject`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Name mismatch' });
    expect(again.status).toBe(409);
    expect(await prisma.withdrawalDebit.count()).toBe(0);

    const summary = await http()
      .get('/astrologers/me/withdrawals/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string; withdrawableAmount: string }>(summary),
    ).toEqual(
      expect.objectContaining({
        reservedAmount: '0.00',
        withdrawableAmount: '2000.00',
      }),
    );

    const second = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const secondId = bodyOf<{ id: string }>(second).id;
    await http()
      .post(`/admin/finance/withdrawals/${secondId}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'SHOULD-NOT-PAY',
        actualTransferredAt: new Date().toISOString(),
      })
      .expect(409);
    expect(await prisma.withdrawalDebit.count()).toBe(0);
  });

  it('does not let two concurrent requests reserve the same funds', async () => {
    const ctx = await seedEarning('1250.00');
    const bank = await addBank(ctx.token);
    const send = () =>
      http()
        .post('/astrologers/me/withdrawals')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: '1000.00', bankAccountId: bank.id });
    const [first, second] = await Promise.all([send(), send()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);
    expect(await prisma.withdrawalRequest.count()).toBe(1);
    const failed = first.status === 400 ? first : second;
    expect(messageOf(failed.body)).toContain('WITHDRAWAL_INSUFFICIENT_FUNDS');
  });

  it('rolls back a failed mark-paid and rejects a duplicate transfer reference', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { admin, token: adminBearer } = await adminToken();
    const make = async () => {
      const created = await http()
        .post('/astrologers/me/withdrawals')
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({ amount: '1000.00', bankAccountId: bank.id })
        .expect(201);
      const id = bodyOf<{ id: string }>(created).id;
      await http()
        .post(`/admin/finance/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .expect(201);
      return id;
    };
    const firstId = await make();
    const secondId = await make();
    await http()
      .post(`/admin/finance/withdrawals/${firstId}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'SHARED-REF',
        actualTransferredAt: '2026-10-20T10:00:00.000Z',
      })
      .expect(201);
    const dup = await http()
      .post(`/admin/finance/withdrawals/${secondId}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'SHARED-REF',
        actualTransferredAt: '2026-10-20T11:00:00.000Z',
      });
    expect(dup.status).toBe(409);
    expect(messageOf(dup.body)).toContain('TRANSFER_REFERENCE_TAKEN');
    const second = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id: secondId },
      include: { debit: true },
    });
    expect(second.status).toBe(WithdrawalStatus.APPROVED);
    expect(second.debit).toBeNull();

    const third = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '0.00', bankAccountId: bank.id });
    expect(third.status).toBe(400);

    const rollbackId = secondId;
    await expect(
      withdrawals.markPaid({ ...admin, id: 'missing-admin-id' }, rollbackId, {
        transferReference: 'ROLLBACK-REF',
        actualTransferredAt: '2026-10-20T12:00:00.000Z',
      }),
    ).rejects.toThrow();
    const after = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id: rollbackId },
      include: { debit: true },
    });
    expect(after.status).toBe(WithdrawalStatus.APPROVED);
    expect(after.debit).toBeNull();
    expect(after.transferReference).toBeNull();
  });

  it('hides other astrologers records and blocks non-admin processing', async () => {
    const owner = await seedEarning('2500.00');
    const other = await seedEarning('2500.00');
    const bank = await addBank(owner.token);
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;

    await http()
      .get(`/astrologers/me/withdrawals/${id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);
    await http()
      .patch(`/astrologers/me/bank-accounts/${bank.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ isActive: false })
      .expect(404);

    const { token: adminBearer } = await adminToken();
    const adminList = await http()
      .get('/admin/finance/withdrawals')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    const listed = bodyOf<{
      items: Array<{
        id: string;
        astrologerName?: string;
        beneficiaryName?: string;
        customerName?: string;
      }>;
    }>(adminList).items.find((item) => item.id === id);
    expect(listed).toEqual(
      expect.objectContaining({
        astrologerName: owner.astroUser.name,
        beneficiaryName: owner.astroUser.name,
      }),
    );
    expect(listed).not.toHaveProperty('customerName');
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(403);
    await http()
      .get('/admin/finance/withdrawals')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(403);
    await http()
      .get('/astrologers/me/bank-accounts')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(403);

    const customer = await createUser(UserRole.PUBLIC);
    await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${await tokenFor(customer)}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(403);

    await http().get('/astrologers/me/withdrawals/summary').expect(401);
  });

  it('reports a reservation that exceeds the wallet without repairing it', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    await prisma.walletAccount.update({
      where: { userId: ctx.astroUser.id },
      data: { availableBalance: new Prisma.Decimal('10.00') },
    });
    const recon = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    const codes = bodyOf<{ issues: Array<{ code: string }> }>(recon).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain('WITHDRAWAL_RESERVATION_EXCEEDS_WALLET');
    expect(await prisma.withdrawalRequest.count()).toBe(1);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(wallet.availableBalance.toFixed(2)).toBe('10.00');
  });

  it('keeps one outcome when approve and reject race', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;
    const walletBefore = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });

    const [approved, rejected] = await Promise.all([
      http()
        .post(`/admin/finance/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminBearer}`),
      http()
        .post(`/admin/finance/withdrawals/${id}/reject`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({ reason: 'Race rejection' }),
    ]);
    const statuses = [approved.status, rejected.status].sort();
    expect(statuses).toEqual([201, 409]);

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
      include: { debit: true, events: true },
    });
    expect([WithdrawalStatus.APPROVED, WithdrawalStatus.REJECTED]).toContain(
      row.status,
    );
    expect(row.debit).toBeNull();
    expect(
      row.events.filter((event) => event.action !== 'CREATED'),
    ).toHaveLength(1);
    const walletAfter = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(walletAfter.availableBalance.toFixed(2)).toBe(
      walletBefore.availableBalance.toFixed(2),
    );
  });

  it('pays a request once when two mark-paid calls race', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);

    const pay = (reference: string) =>
      http()
        .post(`/admin/finance/withdrawals/${id}/mark-paid`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({
          transferReference: reference,
          actualTransferredAt: '2026-10-20T10:00:00.000Z',
        });
    const [first, second] = await Promise.all([
      pay('RACE-REF-A'),
      pay('RACE-REF-B'),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await prisma.withdrawalDebit.count()).toBe(1);
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe(WithdrawalStatus.PAID);
    expect(['RACE-REF-A', 'RACE-REF-B']).toContain(row.transferReference);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(wallet.availableBalance.toFixed(2)).toBe('1000.00');
  });

  it('refuses payout after an earning reversal claws the reserved balance back', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;

    await prisma.appointment.update({
      where: { id: ctx.appointmentId },
      data: { refundObligation: 'FULL_REFUND_DUE' },
    });
    const reversed = await ledger.reversePostedSnapshotForRefundObligation(
      ctx.appointmentId,
    );
    expect(reversed.ok).toBe(true);

    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(wallet.availableBalance.toFixed(2)).toBe('0.00');
    const summary = await http()
      .get('/astrologers/me/withdrawals/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string; withdrawableAmount: string }>(summary),
    ).toEqual(
      expect.objectContaining({
        reservedAmount: '1000.00',
        withdrawableAmount: '0.00',
      }),
    );

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
    expect(messageOf(paid.body)).toContain('WITHDRAWAL_WALLET_SHORTFALL');

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
      include: { debit: true },
    });
    expect(row.status).toBe(WithdrawalStatus.APPROVED);
    expect(row.debit).toBeNull();
    expect(await prisma.withdrawalDebit.count()).toBe(0);
    const earningReversal = await prisma.ledgerEntry.count({
      where: {
        userId: ctx.astroUser.id,
        category: 'ASTROLOGER_EARNING',
        kind: 'DEBIT',
      },
    });
    expect(earningReversal).toBe(1);

    const recon = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(
      bodyOf<{ issues: Array<{ code: string }> }>(recon).issues.map(
        (issue) => issue.code,
      ),
    ).toContain('WITHDRAWAL_RESERVATION_EXCEEDS_WALLET');
    const untouched = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(untouched.availableBalance.toFixed(2)).toBe('0.00');
  });

  it('cancels an approved withdrawal once and releases the reservation without a debit', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { admin, token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);

    const earningEntriesBefore = await prisma.ledgerEntry.count({
      where: { userId: ctx.astroUser.id },
    });
    const forbidden = await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ reason: 'Astrologer must not cancel' });
    expect(forbidden.status).toBe(403);

    const cancelled = await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: '  Wallet shortfall after reversal  ' })
      .expect(201);
    expect(
      bodyOf<{ status: string; cancellationReason: string }>(cancelled),
    ).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        cancellationReason: 'Wallet shortfall after reversal',
      }),
    );

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
      include: { debit: true, events: true },
    });
    expect(row.status).toBe(WithdrawalStatus.CANCELLED);
    expect(row.cancelledByAdminId).toBe(admin.id);
    expect(row.cancellationReason).toBe('Wallet shortfall after reversal');
    expect(row.debit).toBeNull();
    expect(
      row.events.filter((event) => event.action === 'CANCELLED'),
    ).toHaveLength(1);
    expect(await prisma.withdrawalDebit.count()).toBe(0);
    expect(
      await prisma.ledgerEntry.count({ where: { userId: ctx.astroUser.id } }),
    ).toBe(earningEntriesBefore);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(wallet.availableBalance.toFixed(2)).toBe('2000.00');
    const summary = await http()
      .get('/astrologers/me/withdrawals/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string; withdrawableAmount: string }>(summary),
    ).toEqual(
      expect.objectContaining({
        reservedAmount: '0.00',
        withdrawableAmount: '2000.00',
      }),
    );
    expect(
      await prisma.auditLog.count({
        where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
      }),
    ).toBe(1);

    const again = await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Wallet shortfall after reversal' });
    expect(again.status).toBe(409);
    expect(messageOf(again.body)).toContain('WITHDRAWAL_INVALID_STATE');
    expect(
      await prisma.auditLog.count({
        where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.withdrawalRequest.findUniqueOrThrow({
          where: { id },
          include: { events: true },
        })
      ).events.filter((event) => event.action === 'CANCELLED'),
    ).toHaveLength(1);

    const approveAgain = await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`);
    expect(approveAgain.status).toBe(409);
    const payAgain = await http()
      .post(`/admin/finance/withdrawals/${id}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'AFTER-CANCEL',
        actualTransferredAt: '2026-10-20T10:00:00.000Z',
      });
    expect(payAgain.status).toBe(409);
    expect(await prisma.withdrawalDebit.count()).toBe(0);
    expect(
      (await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe(WithdrawalStatus.CANCELLED);
  });

  it('rejects a missing or blank cancellation reason', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);

    for (const body of [{}, { reason: '   ' }, { reason: 'no' }]) {
      const res = await http()
        .post(`/admin/finance/withdrawals/${id}/cancel`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send(body);
      expect(res.status).toBe(400);
    }
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe(WithdrawalStatus.APPROVED);
    expect(
      await prisma.auditLog.count({
        where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
      }),
    ).toBe(0);
    expect(
      await prisma.withdrawalEvent.count({
        where: { withdrawalId: id, action: 'CANCELLED' },
      }),
    ).toBe(0);
  });

  it('refuses cancellation unless the request is approved', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const reason = { reason: 'Cannot pay this request' };

    const pending = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const pendingId = bodyOf<{ id: string }>(pending).id;
    const pendingCancel = await http()
      .post(`/admin/finance/withdrawals/${pendingId}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send(reason);
    expect(pendingCancel.status).toBe(409);
    expect(messageOf(pendingCancel.body)).toContain('WITHDRAWAL_INVALID_STATE');
    expect(
      (
        await prisma.withdrawalRequest.findUniqueOrThrow({
          where: { id: pendingId },
        })
      ).status,
    ).toBe(WithdrawalStatus.PENDING_REVIEW);

    await http()
      .post(`/admin/finance/withdrawals/${pendingId}/reject`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Declined while pending' })
      .expect(201);
    const rejectedCancel = await http()
      .post(`/admin/finance/withdrawals/${pendingId}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send(reason);
    expect(rejectedCancel.status).toBe(409);
    expect(
      (
        await prisma.withdrawalRequest.findUniqueOrThrow({
          where: { id: pendingId },
        })
      ).status,
    ).toBe(WithdrawalStatus.REJECTED);

    const paid = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const paidId = bodyOf<{ id: string }>(paid).id;
    await http()
      .post(`/admin/finance/withdrawals/${paidId}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);
    await http()
      .post(`/admin/finance/withdrawals/${paidId}/mark-paid`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({
        transferReference: 'PAID-BEFORE-CANCEL',
        actualTransferredAt: '2026-10-20T10:00:00.000Z',
      })
      .expect(201);
    const paidCancel = await http()
      .post(`/admin/finance/withdrawals/${paidId}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send(reason);
    expect(paidCancel.status).toBe(409);
    const paidRow = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id: paidId },
      include: { debit: true },
    });
    expect(paidRow.status).toBe(WithdrawalStatus.PAID);
    expect(paidRow.debit).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { action: 'WITHDRAWAL_CANCELLED' },
      }),
    ).toBe(0);
    expect(
      await prisma.withdrawalEvent.count({ where: { action: 'CANCELLED' } }),
    ).toBe(0);
  });

  it('lets exactly one of cancel and mark-paid commit', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
    const id = bodyOf<{ id: string }>(created).id;
    await http()
      .post(`/admin/finance/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(201);

    const [cancelled, paid] = await Promise.all([
      http()
        .post(`/admin/finance/withdrawals/${id}/cancel`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({ reason: 'Racing a payout' }),
      http()
        .post(`/admin/finance/withdrawals/${id}/mark-paid`)
        .set('Authorization', `Bearer ${adminBearer}`)
        .send({
          transferReference: 'RACE-CANCEL-PAY',
          actualTransferredAt: '2026-10-20T10:00:00.000Z',
        }),
    ]);
    const statuses = [cancelled.status, paid.status].sort();
    expect(statuses).toEqual([201, 409]);

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
      include: { debit: true },
    });
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    const cancelAudits = await prisma.auditLog.count({
      where: { entityId: id, action: 'WITHDRAWAL_CANCELLED' },
    });
    const paidAudits = await prisma.auditLog.count({
      where: { entityId: id, action: 'WITHDRAWAL_PAID' },
    });
    if (row.status === WithdrawalStatus.CANCELLED) {
      expect(cancelled.status).toBe(201);
      expect(paid.status).toBe(409);
      expect(row.debit).toBeNull();
      expect(wallet.availableBalance.toFixed(2)).toBe('2000.00');
      expect(cancelAudits).toBe(1);
      expect(paidAudits).toBe(0);
    } else {
      expect(row.status).toBe(WithdrawalStatus.PAID);
      expect(paid.status).toBe(201);
      expect(cancelled.status).toBe(409);
      expect(row.debit?.amount.toFixed(2)).toBe('1000.00');
      expect(wallet.availableBalance.toFixed(2)).toBe('1000.00');
      expect(cancelAudits).toBe(0);
      expect(paidAudits).toBe(1);
    }
    expect(await prisma.withdrawalDebit.count()).toBe(
      row.status === WithdrawalStatus.PAID ? 1 : 0,
    );
  });

  it('reconciles a cancelled withdrawal as unreserved and flags an unexpected debit', async () => {
    const ctx = await seedEarning('2500.00');
    const bank = await addBank(ctx.token);
    const { token: adminBearer } = await adminToken();
    const created = await http()
      .post('/astrologers/me/withdrawals')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ amount: '1000.00', bankAccountId: bank.id })
      .expect(201);
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
    const detail = await http()
      .get(`/admin/finance/withdrawals/${id}`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(
      bodyOf<{
        funds: {
          availableBalance: string;
          reservedAmount: string;
          shortfallAmount: string;
        };
      }>(detail).funds,
    ).toEqual({
      availableBalance: '0.00',
      reservedAmount: '1000.00',
      shortfallAmount: '1000.00',
    });
    await http()
      .post(`/admin/finance/withdrawals/${id}/cancel`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ reason: 'Earning reversal left a shortfall' })
      .expect(201);

    const summary = await http()
      .get('/astrologers/me/withdrawals/summary')
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    expect(
      bodyOf<{ reservedAmount: string; withdrawableAmount: string }>(summary),
    ).toEqual(
      expect.objectContaining({
        reservedAmount: '0.00',
        withdrawableAmount: '0.00',
      }),
    );
    const before = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    const beforeCodes = bodyOf<{ issues: Array<{ code: string }> }>(
      before,
    ).issues.map((issue) => issue.code);
    expect(beforeCodes).not.toContain('WITHDRAWAL_RESERVATION_EXCEEDS_WALLET');
    expect(beforeCodes).not.toContain('CANCELLED_WITHDRAWAL_HAS_DEBIT');
    const stillCancelled = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(stillCancelled.status).toBe(WithdrawalStatus.CANCELLED);

    await prisma.withdrawalDebit.create({
      data: {
        idempotencyKey: `withdrawal:${id}:DEBIT`,
        withdrawalRequestId: id,
        userId: ctx.astroUser.id,
        amount: new Prisma.Decimal('1000.00'),
        currency: 'LKR',
      },
    });
    const after = await http()
      .get('/admin/finance/reconcile')
      .set('Authorization', `Bearer ${adminBearer}`)
      .expect(200);
    expect(
      bodyOf<{ issues: Array<{ code: string }> }>(after).issues.map(
        (issue) => issue.code,
      ),
    ).toContain('CANCELLED_WITHDRAWAL_HAS_DEBIT');
    const untouched = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(untouched.status).toBe(WithdrawalStatus.CANCELLED);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId: ctx.astroUser.id },
    });
    expect(wallet.availableBalance.toFixed(2)).toBe('0.00');
  });
});

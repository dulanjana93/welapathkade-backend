import { HttpException } from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ProposalStatus,
  SavedCardConsentEventType,
  SavedCardStatus,
  UserRole,
  type User,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { BookingGuardService } from '../availability/booking-guard.service';
import { BankAccountCrypto } from '../withdrawals/bank-account.crypto';
import { AUTOMATIC_PAYMENT_CONSENT_VERSION } from './saved-card.consent';
import { SavedCardChargeService } from './saved-card-charge.service';
import { SavedCardService } from './saved-card.service';
import {
  officialPayHereUrls,
  PayHereChargeNotSentError,
  PayHereGateway,
  type PayHereChargeCall,
} from './payhere/payhere.gateway';

jest.setTimeout(20_000);

type PauseMode = 'revoke' | 'dispatch' | null;

type DbClient = PrismaClient;

type Fixture = {
  customer: User;
  astrologerId: string;
  consultationId: string;
  proposalId: string;
  appointmentId: string;
  paymentId: string;
  attemptId: string;
  cardId: string;
};

const createdUserIds = new Set<string>();
const createdServiceIds = new Set<string>();
const createdConsultationIds = new Set<string>();
const createdAppointmentIds = new Set<string>();
const createdCardIds = new Set<string>();

let databaseUrl = '';
let baseline: {
  users: number;
  cards: number;
  attempts: number;
  appointments: number;
} | null = null;
let holder: DbClient;
let other: DbClient;
let probe: DbClient;
let crypto: BankAccountCrypto;
let pauseMode: PauseMode = null;
let releasePause: () => void = () => undefined;
let markPaused: () => void = () => undefined;
let paused: Promise<void> = Promise.resolve();

function loadEnvFile() {
  if (process.env.DATABASE_URL && process.env.BANK_ACCOUNT_ENCRYPTION_KEY) return;
  const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(DATABASE_URL|BANK_ACCOUNT_ENCRYPTION_KEY)=(.*)$/.exec(line);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function assertLocalDevDatabase(urlValue: string) {
  const url = new URL(urlValue);
  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!((host === 'localhost' || host === '127.0.0.1') && url.port === '3307')) {
    throw new Error(`Refusing non-local database host ${host}:${url.port}`);
  }
  if (database !== 'welapathkade') {
    throw new Error(`Refusing database ${database}`);
  }
  return { host, port: url.port, database };
}

function limitedUrl(urlValue: string) {
  const url = new URL(urlValue);
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

function client(urlValue: string) {
  return new PrismaClient({ datasources: { db: { url: limitedUrl(urlValue) } } });
}

function pausingClient(urlValue: string) {
  return client(urlValue).$extends({
    query: {
      savedPaymentMethod: {
        async updateMany({ args, query }) {
          const result = await query(args);
          const status = (args.data as { status?: string } | undefined)?.status;
          if (pauseMode === 'revoke' && status === SavedCardStatus.DISABLED) {
            markPaused();
            await new Promise<void>((resolve) => {
              releasePause = resolve;
            });
          }
          return result;
        },
      },
      paymentAttempt: {
        async updateMany({ args, query }) {
          const result = await query(args);
          const payload = (args.data as { checkoutPayload?: { dispatchAuthorizedAt?: string } })
            ?.checkoutPayload;
          if (pauseMode === 'dispatch' && payload?.dispatchAuthorizedAt) {
            markPaused();
            await new Promise<void>((resolve) => {
              releasePause = resolve;
            });
          }
          return result;
        },
      },
    },
  });
}

function armPause() {
  paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  releasePause = () => undefined;
}

function deferredRelease() {
  armPause();
  return {
    entered: paused,
    release: () => releasePause(),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function remainsPending(promise: Promise<unknown>, ms: number) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (settled) {
    throw new Error('The second transaction finished while the first lock was still held');
  }
}

async function connectionId(db: { $queryRaw: DbClient['$queryRaw'] }) {
  const rows = await db.$queryRaw<Array<{ id: bigint }>>`SELECT CONNECTION_ID() AS id`;
  return String(rows[0].id);
}

async function rowLockHeld(cardId: string, userId: string) {
  try {
    await probe.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT \`id\`
          FROM \`SavedPaymentMethod\`
          WHERE \`id\` = ${cardId} AND \`userId\` = ${userId}
          FOR UPDATE NOWAIT
        `;
      },
      { timeout: 2_000 },
    );
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('3572') ||
      message.includes('NOWAIT') ||
      message.includes('could not be acquired immediately')
    ) {
      return true;
    }
    throw error;
  }
}

function dispatchApi(service: SavedCardChargeService) {
  return service as unknown as {
    authorizeDispatch(userId: string, cardId: string, attemptId: string): Promise<boolean>;
  };
}

function chargeService(
  db: DbClient,
  cards: SavedCardService,
  payhere: PayHereGateway | null,
) {
  return new SavedCardChargeService(
    db as never,
    {
      assertProposedSlotEligible: async () => {
        throw new Error('Availability must not run for a live payment hold');
      },
    } as never,
    {
      expireDueReservations: async () => ({ appointments: 0, payments: 0, attempts: 0 }),
      loadOccupiedIntervals: async () => [],
    } as never,
    new BookingGuardService(db as never),
    cards,
    { finalizeVerified: async () => ({}) } as never,
    payhere,
  );
}

async function createFixture(db: DbClient, label: string): Promise<Fixture> {
  const suffix = `${label}${randomBytes(4).toString('hex')}`;
  const phone = `+947${randomInt(10_000_000, 99_999_999)}`;
  const astroPhone = `+947${randomInt(10_000_000, 99_999_999)}`;
  const customer = await db.user.create({
    data: {
      phone,
      name: `p631 ${suffix}`,
      role: UserRole.PUBLIC,
      referralCode: `p631c${suffix}`.slice(0, 32),
      billingFirstName: 'Nimal',
      billingLastName: 'Perera',
      billingEmail: `${suffix}@example.com`,
      billingAddress: '12 Temple Road',
      billingCity: 'Colombo',
      billingCountry: 'Sri Lanka',
    },
  });
  createdUserIds.add(customer.id);
  const astrologerUser = await db.user.create({
    data: {
      phone: astroPhone,
      name: `p631 astro ${suffix}`,
      role: UserRole.ASTROLOGER,
      referralCode: `p631a${suffix}`.slice(0, 32),
    },
  });
  createdUserIds.add(astrologerUser.id);
  const profile = await db.astrologerProfile.create({
    data: { userId: astrologerUser.id, displayName: `p631 ${suffix}` },
  });
  const service = await db.service.create({
    data: {
      code: `p631-${suffix}`.slice(0, 40),
      nameSi: 'p631',
      nameEn: 'p631',
      minPrice: '1000.00',
      maxPrice: '2000.00',
    },
  });
  createdServiceIds.add(service.id);
  const astrologerService = await db.astrologerService.create({
    data: { astrologerId: profile.id, serviceId: service.id, price: '1500.00' },
  });
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const consultation = await db.consultation.create({
    data: {
      customerId: customer.id,
      astrologerId: profile.id,
      astrologerServiceId: astrologerService.id,
      serviceId: service.id,
      requestedPrice: '1500.00',
      serviceNameSi: 'p631',
      serviceNameEn: 'p631',
      status: ConsultationStatus.ACCEPTED,
      preferredStartAt: start,
      submittedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  });
  createdConsultationIds.add(consultation.id);
  const proposal = await db.consultationProposal.create({
    data: {
      consultationId: consultation.id,
      proposedStartAt: start,
      proposedEndAt: new Date(start.getTime() + 30 * 60 * 1000),
      durationMinutes: 30,
      status: ProposalStatus.ACCEPTED,
    },
  });
  const appointment = await db.appointment.create({
    data: {
      consultationId: consultation.id,
      proposalId: proposal.id,
      customerId: customer.id,
      astrologerId: profile.id,
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60 * 1000),
      durationMinutes: 30,
      status: AppointmentStatus.PAYMENT_PENDING,
      amount: '1500.00',
      currency: 'LKR',
      reservationExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  createdAppointmentIds.add(appointment.id);
  const payment = await db.payment.create({
    data: {
      appointmentId: appointment.id,
      consultationId: consultation.id,
      amount: '1500.00',
      currency: 'LKR',
      status: PaymentStatus.PENDING,
      provider: PaymentProvider.PAYHERE,
    },
  });
  const attempt = await db.paymentAttempt.create({
    data: {
      paymentId: payment.id,
      provider: PaymentProvider.PAYHERE,
      merchantReference: `sc_${suffix}`,
      status: PaymentStatus.PENDING,
      openChargeSlot: payment.id,
      requiresReview: false,
      checkoutPayload: Prisma.JsonNull,
    },
  });
  const encrypted = crypto.encryptOpaque(`p631-token-${suffix}`);
  const card = await db.savedPaymentMethod.create({
    data: {
      userId: customer.id,
      provider: PaymentProvider.PAYHERE,
      status: SavedCardStatus.ACTIVE,
      merchantReference: `pa_${suffix}`,
      tokenCiphertext: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.tag,
      consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
      consentedAt: new Date(),
      authorizationEnabled: true,
      openCardSlot: customer.id,
    },
  });
  createdCardIds.add(card.id);
  await db.savedCardConsentEvent.create({
    data: {
      userId: customer.id,
      savedPaymentMethodId: card.id,
      type: SavedCardConsentEventType.CONSENT_GRANTED,
      consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
    },
  });
  return {
    customer,
    astrologerId: profile.id,
    consultationId: consultation.id,
    proposalId: proposal.id,
    appointmentId: appointment.id,
    paymentId: payment.id,
    attemptId: attempt.id,
    cardId: card.id,
  };
}

async function cleanup(db: DbClient) {
  const cardIds = [...createdCardIds];
  const appointmentIds = [...createdAppointmentIds];
  const consultationIds = [...createdConsultationIds];
  const userIds = [...createdUserIds];
  const serviceIds = [...createdServiceIds];
  if (cardIds.length > 0) {
    await db.paymentAttempt.deleteMany({
      where: { savedPaymentMethodId: { in: cardIds } },
    });
    await db.savedCardConsentEvent.deleteMany({
      where: { savedPaymentMethodId: { in: cardIds } },
    });
    await db.savedPaymentMethod.deleteMany({ where: { id: { in: cardIds } } });
  }
  if (appointmentIds.length > 0) {
    await db.paymentAttempt.deleteMany({
      where: { payment: { appointmentId: { in: appointmentIds } } },
    });
    await db.payment.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  }
  if (consultationIds.length > 0) {
    await db.consultationProposal.deleteMany({
      where: { consultationId: { in: consultationIds } },
    });
    await db.consultation.deleteMany({ where: { id: { in: consultationIds } } });
  }
  if (userIds.length > 0) {
    await db.astrologerBookingGuard.deleteMany({
      where: { astrologer: { userId: { in: userIds } } },
    });
    await db.astrologerService.deleteMany({
      where: { astrologer: { userId: { in: userIds } } },
    });
    await db.astrologerProfile.deleteMany({ where: { userId: { in: userIds } } });
  }
  if (serviceIds.length > 0) {
    await db.service.deleteMany({ where: { id: { in: serviceIds } } });
  }
  if (userIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  createdCardIds.clear();
  createdAppointmentIds.clear();
  createdConsultationIds.clear();
  createdServiceIds.clear();
  createdUserIds.clear();
}

async function snapshot(db: DbClient) {
  const [users, cards, attempts, appointments] = await Promise.all([
    db.user.count(),
    db.savedPaymentMethod.count(),
    db.paymentAttempt.count(),
    db.appointment.count(),
  ]);
  return { users, cards, attempts, appointments };
}

describe('saved-card dispatch MySQL concurrency', () => {
  let target: { host: string; port: string; database: string };
  let holderIds = '';
  let otherIds = '';
  let probeIds = '';
  let isolation = '';

  beforeAll(async () => {
    loadEnvFile();
    databaseUrl = process.env.DATABASE_URL ?? '';
    const key = process.env.BANK_ACCOUNT_ENCRYPTION_KEY ?? '';
    if (!databaseUrl || !key) throw new Error('Local database configuration is incomplete');
    target = assertLocalDevDatabase(databaseUrl);
    crypto = new BankAccountCrypto({
      getOrThrow: () => key,
    } as ConfigService);
    holder = pausingClient(databaseUrl) as unknown as DbClient;
    other = client(databaseUrl);
    probe = client(databaseUrl);
    const names = await probe.$queryRaw<Array<{ name: string }>>`SELECT DATABASE() AS name`;
    if (names[0]?.name !== 'welapathkade') {
      throw new Error(`Connected database was ${String(names[0]?.name)}`);
    }
    const levels = await probe.$queryRaw<Array<{ isolationLevel: string }>>`
      SELECT @@transaction_isolation AS isolationLevel
    `;
    isolation = levels[0].isolationLevel;
    holderIds = await connectionId(holder);
    otherIds = await connectionId(other);
    probeIds = await connectionId(probe);
    if (new Set([holderIds, otherIds, probeIds]).size !== 3) {
      throw new Error('MySQL connections were not independent');
    }
    const chargeSource = readFileSync(
      resolve(process.cwd(), 'src/payments/saved-card-charge.service.ts'),
      'utf8',
    );
    const cardSource = readFileSync(
      resolve(process.cwd(), 'src/payments/saved-card.service.ts'),
      'utf8',
    );
    expect(chargeSource).toContain('FROM \\`SavedPaymentMethod\\`');
    expect(chargeSource).toContain('${cardId} AND \\`userId\\` = ${userId}');
    expect(chargeSource).toContain('FOR UPDATE');
    expect(cardSource).toContain('${id} AND \\`userId\\` = ${userId}');
    expect(cardSource).toContain('FOR UPDATE');
    baseline = await snapshot(probe);
    console.log(
      `mysql target host=${target.host} port=${target.port} database=${target.database} isolation=${isolation} connections=${holderIds},${otherIds},${probeIds}`,
    );
  });

  afterEach(async () => {
    pauseMode = null;
    releasePause();
    await cleanup(probe);
  });

  afterAll(async () => {
    try {
      if (baseline && probe) {
        const after = await snapshot(probe);
        expect(after).toEqual(baseline);
      }
    } finally {
      await Promise.all([
        holder?.$disconnect(),
        other?.$disconnect(),
        probe?.$disconnect(),
      ]);
    }
  });

  it('blocks dispatch until a revocation transaction commits', async () => {
    const fixture = await createFixture(probe, 'rev');
    const cards = new SavedCardService(holder as never, null, crypto);
    const charges = chargeService(other, new SavedCardService(other as never, null, crypto), null);
    pauseMode = 'revoke';
    const gate = deferredRelease();
    const revokePromise = cards.revoke(fixture.customer.id, fixture.cardId);
    await withTimeout(gate.entered, 4_000, 'revocation lock');
    const dispatchPromise = dispatchApi(charges).authorizeDispatch(
      fixture.customer.id,
      fixture.cardId,
      fixture.attemptId,
    );
    await remainsPending(dispatchPromise, 200);
    expect(await rowLockHeld(fixture.cardId, fixture.customer.id)).toBe(true);
    const during = await probe.paymentAttempt.findUniqueOrThrow({
      where: { id: fixture.attemptId },
    });
    expect(during.checkoutPayload).toBeNull();
    gate.release();
    await withTimeout(revokePromise, 4_000, 'revocation commit');
    const allowed = await withTimeout(dispatchPromise, 4_000, 'dispatch after revocation');
    expect(allowed).toBe(false);
    const attempt = await probe.paymentAttempt.findUniqueOrThrow({
      where: { id: fixture.attemptId },
    });
    const card = await probe.savedPaymentMethod.findUniqueOrThrow({
      where: { id: fixture.cardId },
    });
    expect(attempt.checkoutPayload).toBeNull();
    expect(attempt.status).toBe(PaymentStatus.PENDING);
    expect(card.status).toBe(SavedCardStatus.DISABLED);
    expect(card.tokenCiphertext).toBeNull();
    expect(card.authorizationEnabled).toBe(false);
  });

  it('blocks revocation until dispatch authorization commits', async () => {
    const fixture = await createFixture(probe, 'dsp');
    const cards = new SavedCardService(other as never, null, crypto);
    const charges = chargeService(holder, new SavedCardService(holder as never, null, crypto), null);
    pauseMode = 'dispatch';
    const gate = deferredRelease();
    const dispatchPromise = dispatchApi(charges).authorizeDispatch(
      fixture.customer.id,
      fixture.cardId,
      fixture.attemptId,
    );
    await withTimeout(gate.entered, 4_000, 'dispatch lock');
    const revokePromise = cards.revoke(fixture.customer.id, fixture.cardId);
    await remainsPending(revokePromise, 200);
    expect(await rowLockHeld(fixture.cardId, fixture.customer.id)).toBe(true);
    const during = await probe.savedPaymentMethod.findUniqueOrThrow({
      where: { id: fixture.cardId },
    });
    expect(during.status).toBe(SavedCardStatus.ACTIVE);
    expect(during.tokenCiphertext).not.toBeNull();
    gate.release();
    const allowed = await withTimeout(dispatchPromise, 4_000, 'dispatch commit');
    await withTimeout(revokePromise, 4_000, 'revocation after dispatch');
    expect(allowed).toBe(true);
    const attempt = await probe.paymentAttempt.findUniqueOrThrow({
      where: { id: fixture.attemptId },
    });
    const card = await probe.savedPaymentMethod.findUniqueOrThrow({
      where: { id: fixture.cardId },
    });
    const payload = attempt.checkoutPayload as { dispatchAuthorizedAt?: string } | null;
    expect(typeof payload?.dispatchAuthorizedAt).toBe('string');
    expect(attempt.status).toBe(PaymentStatus.PENDING);
    expect(attempt.openChargeSlot).toBe(fixture.paymentId);
    expect(card.status).toBe(SavedCardStatus.DISABLED);
    expect(card.tokenCiphertext).toBeNull();
  });

  it('keeps every concurrent ordering in one of the two valid states', async () => {
    const winners = { revocation: 0, dispatch: 0 };
    for (let index = 0; index < 8; index += 1) {
      const fixture = await createFixture(probe, `race${index}`);
      const cards = new SavedCardService(holder as never, null, crypto);
      const charges = chargeService(other, new SavedCardService(other as never, null, crypto), null);
      const first = index % 2 === 0 ? 'revoke' : 'dispatch';
      const revokePromise =
        first === 'revoke'
          ? cards.revoke(fixture.customer.id, fixture.cardId)
          : Promise.resolve().then(() => cards.revoke(fixture.customer.id, fixture.cardId));
      const dispatchPromise =
        first === 'dispatch'
          ? dispatchApi(charges).authorizeDispatch(
              fixture.customer.id,
              fixture.cardId,
              fixture.attemptId,
            )
          : Promise.resolve().then(() =>
              dispatchApi(charges).authorizeDispatch(
                fixture.customer.id,
                fixture.cardId,
                fixture.attemptId,
              ),
            );
      const [allowed] = await Promise.all([
        withTimeout(dispatchPromise, 8_000, 'race dispatch'),
        withTimeout(revokePromise, 8_000, 'race revoke'),
      ]);
      const attempt = await probe.paymentAttempt.findUniqueOrThrow({
        where: { id: fixture.attemptId },
      });
      const card = await probe.savedPaymentMethod.findUniqueOrThrow({
        where: { id: fixture.cardId },
      });
      const payload = attempt.checkoutPayload as { dispatchAuthorizedAt?: string } | null;
      expect(card.status).toBe(SavedCardStatus.DISABLED);
      expect(card.tokenCiphertext).toBeNull();
      expect(attempt.status).not.toBe(PaymentStatus.FAILED);
      if (allowed) {
        expect(typeof payload?.dispatchAuthorizedAt).toBe('string');
        expect(attempt.openChargeSlot).toBe(fixture.paymentId);
        winners.dispatch += 1;
      } else {
        expect(payload?.dispatchAuthorizedAt).toBeUndefined();
        winners.revocation += 1;
      }
      await cleanup(probe);
    }
    expect(winners.revocation + winners.dispatch).toBe(8);
    console.log(
      `unpaced race revocationWins=${winners.revocation} dispatchWins=${winners.dispatch}`,
    );
  });

  it('sees a revocation that lands during OAuth and does not post the charge', async () => {
    const fixture = await createFixture(probe, 'oauth');
    await probe.paymentAttempt.delete({ where: { id: fixture.attemptId } });
    await probe.payment.delete({ where: { id: fixture.paymentId } });
    let chargePosts = 0;
    let releaseOauth: () => void = () => undefined;
    const oauthWaiting = new Promise<void>((resolve) => {
      releaseOauth = resolve;
    });
    let markOauth: () => void = () => undefined;
    const oauthEntered = new Promise<void>((resolve) => {
      markOauth = resolve;
    });
    const urls = officialPayHereUrls('sandbox');
    const gateway = new PayHereGateway(
      {
        mode: 'sandbox',
        merchantId: '1210001',
        merchantSecret: 'mysql-concurrency-test-only',
        appId: 'app-id',
        appSecret: 'app-secret',
        notifyUrl: 'https://api.example.com/payments/callbacks/payhere',
        returnUrl: 'https://app.example.com/payments/return',
        cancelUrl: 'https://app.example.com/payments/cancel',
        ...urls,
      },
      async (url) => {
        const href = String(url);
        if (href === urls.oauthUrl) {
          markOauth();
          await oauthWaiting;
          return {
            ok: true,
            json: async () => ({ access_token: 'oauth-test-token', expires_in: 599 }),
          } as Response;
        }
        if (href === urls.chargeUrl) {
          chargePosts += 1;
          return { ok: true, json: async () => ({ status: 1, data: null }) } as Response;
        }
        throw new Error('Unexpected PayHere URL');
      },
    );
    const cards = new SavedCardService(other as never, null, crypto);
    const charges = chargeService(other, cards, gateway);
    const chargePromise = charges.charge(fixture.customer, fixture.consultationId, fixture.proposalId, fixture.cardId);
    await withTimeout(oauthEntered, 4_000, 'oauth barrier');
    expect(chargePosts).toBe(0);
    await cards.revoke(fixture.customer.id, fixture.cardId);
    releaseOauth();
    await expect(withTimeout(chargePromise, 4_000, 'charge after revocation')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(chargePosts).toBe(0);
    const attempt = await probe.paymentAttempt.findFirstOrThrow({
      where: { payment: { appointmentId: fixture.appointmentId } },
    });
    const card = await probe.savedPaymentMethod.findUniqueOrThrow({
      where: { id: fixture.cardId },
    });
    expect(attempt.status).toBe(PaymentStatus.FAILED);
    expect(attempt.openChargeSlot).toBeNull();
    expect(attempt.checkoutPayload).toBeNull();
    expect(attempt.savedPaymentMethodId).toBe(fixture.cardId);
    expect(card.tokenCiphertext).toBeNull();
  });

  it('does not open a second charge after a duplicate, a restart, or reconciliation', async () => {
    const fixture = await createFixture(probe, 'idem');
    await probe.paymentAttempt.delete({ where: { id: fixture.attemptId } });
    await probe.payment.delete({ where: { id: fixture.paymentId } });
    let chargeCalls = 0;
    let retrievalCalls = 0;
    const payhere = {
      hasMerchantCapacity: () => true,
      chargePayment: async (
        _input: unknown,
        hooks?: { beforeDispatch?: () => Promise<boolean> },
      ): Promise<PayHereChargeCall> => {
        const allowed = await hooks?.beforeDispatch?.();
        if (!allowed) throw new PayHereChargeNotSentError();
        chargeCalls += 1;
        return { kind: 'uncertain' };
      },
      verifyByReference: async () => {
        retrievalCalls += 1;
        return { success: false, pending: true };
      },
    };
    const cards = new SavedCardService(other as never, null, crypto);
    const charges = chargeService(other, cards, payhere as never);
    const first = await charges.charge(
      fixture.customer,
      fixture.consultationId,
      fixture.proposalId,
      fixture.cardId,
    );
    expect(chargeCalls).toBe(1);
    expect(first.reconciliationRequired).toBe(true);
    const stored = await probe.paymentAttempt.findFirstOrThrow({
      where: { merchantReference: first.merchantReference },
    });
    expect(stored.savedPaymentMethodId).toBe(fixture.cardId);
    const second = await charges.charge(
      fixture.customer,
      fixture.consultationId,
      fixture.proposalId,
      'card-not-selected',
    );
    expect(chargeCalls).toBe(1);
    expect(second.merchantReference).toBe(first.merchantReference);
    const unchanged = await probe.paymentAttempt.findUniqueOrThrow({
      where: { id: stored.id },
    });
    expect(unchanged.savedPaymentMethodId).toBe(fixture.cardId);
    const attempts = await probe.paymentAttempt.count({
      where: { payment: { appointmentId: fixture.appointmentId } },
    });
    expect(attempts).toBe(1);

    const open = await probe.paymentAttempt.findFirstOrThrow({
      where: { merchantReference: first.merchantReference },
    });
    const payment = await probe.payment.findUniqueOrThrow({ where: { id: open.paymentId } });
    await probe.paymentAttempt.update({
      where: { id: open.id },
      data: {
        status: PaymentStatus.PENDING,
        requiresReview: false,
        openChargeSlot: payment.id,
        checkoutPayload: { dispatchAuthorizedAt: new Date().toISOString() },
      },
    });
    const restarted = await charges.charge(
      fixture.customer,
      fixture.consultationId,
      fixture.proposalId,
      fixture.cardId,
    );
    expect(chargeCalls).toBe(1);
    expect(restarted.reconciliationRequired).toBe(true);
    const afterRestart = await probe.paymentAttempt.findUniqueOrThrow({ where: { id: open.id } });
    expect(afterRestart.requiresReview).toBe(true);
    expect(afterRestart.status).toBe(PaymentStatus.PENDING);
    expect(
      (afterRestart.checkoutPayload as { dispatchAuthorizedAt?: string }).dispatchAuthorizedAt,
    ).toEqual(expect.any(String));

    await charges.reconcileOne(open.id);
    expect(chargeCalls).toBe(1);
    expect(retrievalCalls).toBe(2);

    await expect(
      probe.paymentAttempt.create({
        data: {
          paymentId: open.paymentId,
          provider: PaymentProvider.PAYHERE,
          merchantReference: `sc_dup_${open.id}`,
          status: PaymentStatus.PENDING,
          openChargeSlot: payment.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

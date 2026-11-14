import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { payHereLogContainsForbidden } from './payhere/payhere-diagnostics';
import {
  PaymentProvider,
  Prisma,
  SavedCardConsentEventType,
  SavedCardFailureReason,
  SavedCardStatus,
  UserRole,
  type SavedCardConsentEvent,
  type SavedPaymentMethod,
  type User,
} from '@prisma/client';
import { BankAccountCrypto } from '../withdrawals/bank-account.crypto';
import { PayHereNotificationError } from './payhere/payhere-signature';
import {
  AUTOMATIC_PAYMENT_CONSENT_VERSION,
} from './saved-card.consent';
import {
  ABANDONED_REGISTRATION_MINUTES,
  SavedCardService,
  failStalePendingRegistrations,
  savedCardIsChargeable,
} from './saved-card.service';

const TOKEN = '59AFEE022CC69CA39D325E1B59130862';

function matchesCard(
  row: SavedPaymentMethod,
  where?: Record<string, unknown>,
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) =>
    matchesValue(row[key as keyof SavedPaymentMethod], expected),
  );
}

/** Minimal Prisma filter semantics used by SavedCardService. */
function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === null;
  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }
  if (typeof expected === 'object') {
    const filter = expected as { in?: unknown[]; not?: unknown; lt?: Date };
    if (filter.in && !filter.in.includes(actual)) return false;
    if ('not' in filter && actual === filter.not) return false;
    if (filter.lt && !(actual instanceof Date && actual < filter.lt)) {
      return false;
    }
    return true;
  }
  return actual === expected;
}

function verifiedSuccess(merchantReference: string) {
  return {
    merchantReference,
    providerPaymentId: '9002',
    outcome: 'success' as const,
    success: true,
    customerToken: TOKEN,
    cardBrand: 'VISA',
    cardLast4: '4242',
  };
}

describe('SavedCardService', () => {
  const cards: SavedPaymentMethod[] = [];
  const events: SavedCardConsentEvent[] = [];
  let seq = 0;
  const crypto = new BankAccountCrypto({
    getOrThrow: () => 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
  } as never);
  const payhere = {
    createPreapproval: jest.fn(
      (input: { merchantReference: string; customer: { firstName: string } }) => ({
        method: 'POST' as const,
        action: 'https://sandbox.payhere.lk/pay/preapprove',
        fields: {
          merchant_id: '1210001',
          order_id: input.merchantReference,
          first_name: input.customer.firstName,
          currency: 'LKR',
          hash: 'HASH',
        },
      }),
    ),
    verifyPreapproval: jest.fn(),
  };
  const user = {
    id: 'user-1',
    role: UserRole.PUBLIC,
    phone: '+94771234567',
    name: 'Nimal',
    billingFirstName: 'Nimal',
    billingLastName: 'Perera',
    billingEmail: 'nimal@example.com',
    billingAddress: '12 Temple Road',
    billingCity: 'Colombo',
    billingCountry: 'Sri Lanka',
  } as User;

  function stamp(data: Partial<SavedPaymentMethod>): SavedPaymentMethod {
    seq += 1;
    const now = new Date(Date.parse('2026-11-01T00:00:00.000Z') + seq * 1000);
    return {
      id: `card-${seq}`,
      userId: user.id,
      provider: PaymentProvider.PAYHERE,
      status: SavedCardStatus.PENDING,
      merchantReference: `pa_${seq}`,
      payherePaymentId: null,
      tokenCiphertext: null,
      tokenIv: null,
      tokenTag: null,
      cardBrand: null,
      cardLast4: null,
      consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
      consentedAt: now,
      authorizationEnabled: false,
      revokedAt: null,
      removedAt: null,
      openCardSlot: user.id,
      failureReason: null,
      failedAt: null,
      lateAuthorizationAt: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    };
  }

  const prisma = {
    payment: { create: jest.fn() },
    appointment: { create: jest.fn() },
    ledgerEntry: { create: jest.fn() },
    consultation: { update: jest.fn() },
    savedPaymentMethod: {
      findMany: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: Partial<SavedPaymentMethod>;
          orderBy?: { createdAt?: 'asc' | 'desc' };
        }) => {
          const rows = cards.filter((row) => matchesCard(row, where));
          if (orderBy?.createdAt === 'desc') {
            return [...rows].sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
            );
          }
          return rows;
        },
      ),
      findFirst: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: Partial<SavedPaymentMethod>;
          orderBy?: { createdAt?: 'asc' | 'desc' };
        }) => {
          const rows = cards.filter((row) => matchesCard(row, where));
          if (orderBy?.createdAt === 'desc') {
            rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return rows[0] ?? null;
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { merchantReference?: string; id?: string } }) =>
          cards.find(
            (row) =>
              (where.merchantReference === undefined ||
                row.merchantReference === where.merchantReference) &&
              (where.id === undefined || row.id === where.id),
          ) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async (args: { where: { id: string } }) => {
        const row = cards.find((item) => item.id === args.where.id);
        if (!row) throw new Error('missing');
        return row;
      }),
      create: jest.fn(async ({ data }: { data: Partial<SavedPaymentMethod> }) => {
        if (
          data.openCardSlot &&
          cards.some((row) => row.openCardSlot === data.openCardSlot)
        ) {
          throw new Prisma.PrismaClientKnownRequestError('Unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = stamp(data);
        cards.push(row);
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<SavedPaymentMethod>;
        }) => {
          const rows = cards.filter((row) => matchesCard(row, where));
          for (const row of rows) {
            Object.assign(row, data, { updatedAt: new Date() });
          }
          return { count: rows.length };
        },
      ),
    },
    savedCardConsentEvent: {
      create: jest.fn(async ({ data }: { data: Partial<SavedCardConsentEvent> }) => {
        const event = {
          id: `event-${events.length + 1}`,
          createdAt: new Date(),
          ...data,
        } as SavedCardConsentEvent;
        events.push(event);
        return event;
      }),
    },
    $queryRaw: jest.fn(async () => [{ id: 'locked' }]),
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work(prisma),
    ),
  };

  const service = new SavedCardService(
    prisma as never,
    payhere,
    crypto,
    null,
  );

  const sleep = jest.fn(async () => undefined);
  service.sleep = sleep;

  beforeEach(() => {
    cards.splice(0, cards.length);
    events.splice(0, events.length);
    seq = 0;
    jest.clearAllMocks();
    sleep.mockImplementation(async () => undefined);
    service.completionWait = { totalMs: 0, intervalMs: 0 };
  });

  it('refuses pre-approval without a complete billing profile or consent', async () => {
    await expect(
      service.start(
        { ...user, billingCity: null } as User,
        true,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.start(user, false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(cards).toHaveLength(0);
    expect(payhere.createPreapproval).not.toHaveBeenCalled();
  });

  it('starts pre-approval with consent and does not return the merchant secret', async () => {
    const started = await service.start(user, true);
    expect(started.consentVersion).toBe(AUTOMATIC_PAYMENT_CONSENT_VERSION);
    expect(started.preapproval.action).toBe(
      'https://sandbox.payhere.lk/pay/preapprove',
    );
    expect(started.preapproval.fields.amount).toBeUndefined();
    expect(JSON.stringify(started)).not.toContain('merchant-secret');
    expect(JSON.stringify(started)).not.toContain(TOKEN);
    expect(events[0]).toMatchObject({
      type: SavedCardConsentEventType.CONSENT_GRANTED,
      consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
      userId: user.id,
    });
    expect(cards[0].status).toBe(SavedCardStatus.PENDING);
    expect(cards[0].authorizationEnabled).toBe(false);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.appointment.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.consultation.update).not.toHaveBeenCalled();
  });

  it('stores an encrypted token only after a verified success', async () => {
    await service.start(user, true);
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: cards[0].merchantReference,
      providerPaymentId: '9001',
      outcome: 'failed',
      success: false,
      customerToken: TOKEN,
      cardBrand: null,
      cardLast4: null,
    });
    await expect(
      service.handleNotify({ order_id: cards[0].merchantReference }),
    ).resolves.toMatchObject({ failed: true });
    expect(cards[0].status).toBe(SavedCardStatus.FAILED);
    expect(cards[0].tokenCiphertext).toBeNull();
    expect(cards[0].openCardSlot).toBeNull();

    const afterFailure = await service.list(user.id);
    expect(afterFailure.pendingRegistration).toBeNull();
    expect(afterFailure.failedRegistration).toEqual({
      id: cards[0].id,
      status: SavedCardStatus.FAILED,
      reason: 'DECLINED',
      consentedAt: cards[0].consentedAt,
      failedAt: cards[0].failedAt,
    });
    expect(afterFailure.methods).toEqual([]);

    await service.start(user, true);
    const pending = cards.find((row) => row.status === SavedCardStatus.PENDING)!;
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: pending.merchantReference,
      providerPaymentId: '9002',
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: 'VISA',
      cardLast4: '4564',
    });
    const activated = await service.handleNotify({});
    expect(activated).toMatchObject({ active: true });
    expect(pending.tokenCiphertext).not.toBe(TOKEN);
    expect(pending.tokenCiphertext).not.toContain(TOKEN);
    expect(JSON.stringify(activated)).not.toContain(TOKEN);
    expect(JSON.stringify(activated)).not.toContain('ciphertext');
    expect(pending.cardLast4).toBe('4564');
    expect(pending.cardBrand).toBe('VISA');
    expect(pending.openCardSlot).toBeNull();
    await expect(service.readActiveToken(user.id, pending.id)).resolves.toBe(
      TOKEN,
    );

    await service.handleNotify({});
    expect(payhere.verifyPreapproval).toHaveBeenCalledTimes(3);
    expect(pending.status).toBe(SavedCardStatus.ACTIVE);
  });

  it('rejects a bad signature and an unknown order', async () => {
    payhere.verifyPreapproval.mockImplementation(() => {
      throw new PayHereNotificationError('Invalid signature');
    });
    await expect(service.handleNotify({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: 'pa_missing',
      providerPaymentId: '',
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: null,
      cardLast4: null,
    });
    await expect(service.handleNotify({})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cards).toHaveLength(0);
  });

  it('revokes authorization, deletes the token, and requires fresh consent', async () => {
    await service.start(user, true);
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: cards[0].merchantReference,
      providerPaymentId: '9002',
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: 'MASTER',
      cardLast4: '1111',
    });
    await service.handleNotify({});
    const revoked = await service.revoke(user.id, cards[0].id);
    expect(revoked.status).toBe(SavedCardStatus.DISABLED);
    expect(revoked.authorizationEnabled).toBe(false);
    expect(cards[0].tokenCiphertext).toBeNull();
    expect(cards[0].openCardSlot).toBeNull();
    expect(events.some((event) => event.type === 'CONSENT_REVOKED')).toBe(true);
    await expect(service.readActiveToken(user.id, cards[0].id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: cards[0].merchantReference,
      providerPaymentId: '9002',
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: 'MASTER',
      cardLast4: '1111',
    });
    await service.handleNotify({});
    expect(cards[0].status).toBe(SavedCardStatus.DISABLED);
    expect(cards[0].tokenCiphertext).toBeNull();

    const again = await service.start(user, true);
    expect(again.savedCardId).not.toBe(cards[0].id);
    expect(
      events.filter((event) => event.type === 'CONSENT_GRANTED'),
    ).toHaveLength(2);
    await expect(service.revoke('other-user', cards[0].id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('removes a card, revokes it, and ignores a repeat', async () => {
    await service.start(user, true);
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: cards[0].merchantReference,
      providerPaymentId: '9002',
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: null,
      cardLast4: null,
    });
    await service.handleNotify({});
    const removed = await service.remove(user.id, cards[0].id);
    expect(removed.status).toBe(SavedCardStatus.REMOVED);
    expect(cards[0].tokenCiphertext).toBeNull();
    expect(cards[0].openCardSlot).toBeNull();
    expect(cards[0].authorizationEnabled).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      'CONSENT_GRANTED',
      'CONSENT_REVOKED',
      'CARD_REMOVED',
    ]);
    const repeat = await service.remove(user.id, cards[0].id);
    expect(repeat.status).toBe(SavedCardStatus.REMOVED);
    expect(events.filter((event) => event.type === 'CARD_REMOVED')).toHaveLength(
      1,
    );
    await expect(service.readActiveToken(user.id, cards[0].id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await service.handleNotify({});
    expect(cards[0].status).toBe(SavedCardStatus.REMOVED);
  });

  it('registers a second and third card after earlier cards are active', async () => {
    await service.start(user, true);
    payhere.verifyPreapproval.mockReturnValue(
      verifiedSuccess(cards[0].merchantReference),
    );
    await service.handleNotify({});
    expect(cards[0].status).toBe(SavedCardStatus.ACTIVE);
    expect(cards[0].openCardSlot).toBeNull();

    const second = await service.start(user, true);
    expect(second.savedCardId).not.toBe(cards[0].id);
    const pending = cards.find((row) => row.id === second.savedCardId)!;
    expect(pending.status).toBe(SavedCardStatus.PENDING);
    expect(pending.openCardSlot).toBe(user.id);
    expect(cards[0].status).toBe(SavedCardStatus.ACTIVE);
    await expect(service.readActiveToken(user.id, cards[0].id)).resolves.toBe(
      TOKEN,
    );
    // Starting again while a registration is open supersedes it instead of
    // blocking the customer.
    const replacement = await service.start(user, true);
    expect(pending).toMatchObject({
      status: SavedCardStatus.FAILED,
      failureReason: SavedCardFailureReason.SUPERSEDED,
      openCardSlot: null,
    });
    expect(cards.filter((row) => row.status === SavedCardStatus.PENDING)).toHaveLength(
      1,
    );
    const open = cards.find((row) => row.id === replacement.savedCardId)!;

    payhere.verifyPreapproval.mockReturnValue(
      verifiedSuccess(open.merchantReference),
    );
    await service.handleNotify({});
    expect(open.status).toBe(SavedCardStatus.ACTIVE);
    expect(open.openCardSlot).toBeNull();
    expect(cards[0].status).toBe(SavedCardStatus.ACTIVE);

    const third = await service.start(user, true);
    expect(cards.filter((row) => row.status === SavedCardStatus.ACTIVE)).toHaveLength(
      2,
    );
    expect(cards.find((row) => row.id === third.savedCardId)?.status).toBe(
      SavedCardStatus.PENDING,
    );
  });

  it('lets only one concurrent registration create a pending row', async () => {
    const results = await Promise.allSettled([
      service.start(user, true),
      service.start(user, true),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(cards.filter((row) => row.status === SavedCardStatus.PENDING)).toHaveLength(
      1,
    );
    expect(new Set(cards.map((row) => row.merchantReference)).size).toBe(1);
  });

  it('activates only the registration named by the merchant reference', async () => {
    await service.start(user, true);
    payhere.verifyPreapproval.mockReturnValue(
      verifiedSuccess(cards[0].merchantReference),
    );
    await service.handleNotify({});
    const second = await service.start(user, true);
    const pending = cards.find((row) => row.id === second.savedCardId)!;
    payhere.verifyPreapproval.mockReturnValue(
      verifiedSuccess(cards[0].merchantReference),
    );
    const replay = await service.handleNotify({});
    expect(replay).toMatchObject({ alreadyHandled: true });
    expect(pending.status).toBe(SavedCardStatus.PENDING);
    expect(pending.openCardSlot).toBe(user.id);
    expect(cards[0].status).toBe(SavedCardStatus.ACTIVE);

    payhere.verifyPreapproval.mockReturnValue(
      verifiedSuccess(pending.merchantReference),
    );
    await service.handleNotify({});
    expect(pending.status).toBe(SavedCardStatus.ACTIVE);
    expect(pending.openCardSlot).toBeNull();
    expect(cards[0].id).not.toBe(pending.id);
    expect(cards[0].status).toBe(SavedCardStatus.ACTIVE);
  });

  async function activatePending() {
    const pending = cards.find((row) => row.status === SavedCardStatus.PENDING);
    if (!pending) throw new Error('expected a pending card');
    payhere.verifyPreapproval.mockReturnValue(
      verifiedSuccess(pending.merchantReference),
    );
    await service.handleNotify({});
    return pending;
  }

  it('lists usable active cards only and never a pending registration', async () => {
    await service.start(user, true);
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: cards[0].merchantReference,
      providerPaymentId: '1',
      outcome: 'failed',
      success: false,
      customerToken: null,
      cardBrand: null,
      cardLast4: null,
    });
    await service.handleNotify({});
    expect(cards[0].openCardSlot).toBeNull();

    await service.start(user, true);
    const first = await activatePending();
    await service.start(user, true);
    const second = await activatePending();
    await service.start(user, true);
    const disabled = await activatePending();
    await service.revoke(user.id, disabled.id);
    await service.start(user, true);
    const removed = await activatePending();
    await service.remove(user.id, removed.id);

    await service.start(user, true);
    const listed = await service.list(user.id);
    expect(listed.consent.version).toBe(AUTOMATIC_PAYMENT_CONSENT_VERSION);
    expect(listed.methods.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(listed.methods.every((row) => row.status === SavedCardStatus.ACTIVE)).toBe(
      true,
    );
    expect(listed.pendingRegistration).toBeNull();
    expect(listed.failedRegistration).toBeNull();
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('tokenIv');
    expect(serialized).not.toContain('merchant_secret');
    expect(listed.methods.map((row) => row.status)).not.toContain(
      SavedCardStatus.FAILED,
    );
    expect(listed.methods.map((row) => row.status)).not.toContain(
      SavedCardStatus.DISABLED,
    );
    expect(listed.methods.map((row) => row.status)).not.toContain(
      SavedCardStatus.REMOVED,
    );
    expect(cards.map((row) => row.status).sort()).toEqual(
      [
        SavedCardStatus.ACTIVE,
        SavedCardStatus.ACTIVE,
        SavedCardStatus.DISABLED,
        SavedCardStatus.FAILED,
        SavedCardStatus.PENDING,
        SavedCardStatus.REMOVED,
      ].sort(),
    );
  });

  describe('registration lifecycle without a persistent PENDING state', () => {
    function notify(
      row: SavedPaymentMethod,
      statusCode: 2 | 0 | -1 | -2,
      options: { token?: string | null; paymentId?: string } = {},
    ) {
      const outcome =
        statusCode === 2 ? 'success' : statusCode === 0 ? 'pending' : 'failed';
      const token = options.token === undefined ? TOKEN : options.token;
      payhere.verifyPreapproval.mockReturnValue({
        merchantReference: row.merchantReference,
        providerPaymentId: options.paymentId ?? '9100',
        amount: '10.00',
        currency: 'LKR',
        statusCode,
        outcome,
        success: outcome === 'success',
        customerToken: outcome === 'success' ? token : null,
        cardBrand: outcome === 'success' ? 'VISA' : null,
        cardLast4: outcome === 'success' ? '4242' : null,
      });
      return service.handleNotify({ order_id: row.merchantReference });
    }

    async function startRow() {
      const started = await service.start(user, true);
      return cards.find((row) => row.id === started.savedCardId)!;
    }

    function openSlots() {
      return cards.filter((row) => row.openCardSlot === user.id);
    }

    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    beforeEach(() => {
      errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
    });
    afterEach(() => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('1. activates a card only from a verified notify, then complete reports ACTIVE', async () => {
      const row = await startRow();
      await expect(notify(row, 2)).resolves.toMatchObject({ active: true });
      const result = await service.complete(user.id, row.id, 'RETURNED');
      expect(result.status).toBe(SavedCardStatus.ACTIVE);
      expect(result.savedCard).toMatchObject({
        id: row.id,
        cardBrand: 'VISA',
        cardLast4: '4242',
        authorizationEnabled: true,
      });
      expect(result.failedRegistration).toBeNull();
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain('ciphertext');
      expect(row.openCardSlot).toBeNull();
      expect(sleep).not.toHaveBeenCalled();
      const listed = await service.list(user.id);
      expect(listed.methods.map((card) => card.id)).toEqual([row.id]);
      expect(listed.failedRegistration).toBeNull();
      expect(listed.pendingRegistration).toBeNull();
    });

    it('2. PayHere rejection (status -2) fails the attempt and is never chargeable', async () => {
      const row = await startRow();
      await expect(notify(row, -2)).resolves.toMatchObject({ failed: true });
      expect(row).toMatchObject({
        status: SavedCardStatus.FAILED,
        failureReason: SavedCardFailureReason.PAYHERE_DECLINED,
        openCardSlot: null,
        authorizationEnabled: false,
        tokenCiphertext: null,
      });
      const result = await service.complete(user.id, row.id, 'RETURNED');
      expect(result).toMatchObject({
        status: SavedCardStatus.FAILED,
        savedCard: null,
        failedRegistration: { id: row.id, reason: 'DECLINED' },
      });
      expect(savedCardIsChargeable(row)).toBe(false);
      await expect(
        service.readActiveToken(user.id, row.id),
      ).rejects.toBeInstanceOf(ConflictException);
      const listed = await service.list(user.id);
      expect(listed.methods).toEqual([]);
      expect(listed.failedRegistration).toMatchObject({
        id: row.id,
        reason: 'DECLINED',
      });
    });

    it('3. customer cancel fails immediately without waiting for PayHere', async () => {
      service.completionWait = { totalMs: 8000, intervalMs: 1000 };
      const row = await startRow();
      const result = await service.complete(user.id, row.id, 'CANCELLED');
      expect(sleep).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: SavedCardStatus.FAILED,
        failedRegistration: { reason: 'CANCELLED' },
      });
      expect(row.failureReason).toBe(SavedCardFailureReason.CUSTOMER_CANCELLED);

      const viaPayHere = await startRow();
      await notify(viaPayHere, -1);
      expect(viaPayHere.failureReason).toBe(
        SavedCardFailureReason.PAYHERE_CANCELLED,
      );
      await expect(
        service.complete(user.id, viaPayHere.id, 'CANCELLED'),
      ).resolves.toMatchObject({ failedRegistration: { reason: 'CANCELLED' } });
    });

    it('4. WebView closing without verified success waits briefly, then fails', async () => {
      service.completionWait = { totalMs: 3000, intervalMs: 1000 };
      const row = await startRow();
      // PayHere status 0 and a success without a token are not verified success.
      await notify(row, 0);
      await notify(row, 2, { token: null });
      expect(row.status).toBe(SavedCardStatus.PENDING);
      const result = await service.complete(user.id, row.id, 'CLOSED');
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        status: SavedCardStatus.FAILED,
        failedRegistration: { reason: 'NOT_CONFIRMED' },
      });
      expect(row.failureReason).toBe(SavedCardFailureReason.NOT_CONFIRMED);
      expect(row.openCardSlot).toBeNull();
    });

    it('4b. a notify that lands during the completion wait activates the card', async () => {
      service.completionWait = { totalMs: 8000, intervalMs: 1000 };
      const row = await startRow();
      sleep.mockImplementation(async () => {
        if (sleep.mock.calls.length === 2) await notify(row, 2);
      });
      const result = await service.complete(user.id, row.id, 'RETURNED');
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(SavedCardStatus.ACTIVE);
      expect(row.status).toBe(SavedCardStatus.ACTIVE);
    });

    it('5. a missing notification never leaves the attempt PENDING', async () => {
      const row = await startRow();
      const result = await service.complete(user.id, row.id, 'RETURNED');
      expect(result.status).toBe(SavedCardStatus.FAILED);
      expect(row.status).toBe(SavedCardStatus.FAILED);
      expect(row.failedAt).toBeInstanceOf(Date);
      const listed = await service.list(user.id);
      expect(listed.pendingRegistration).toBeNull();
      expect(listed.failedRegistration).toMatchObject({
        id: row.id,
        reason: 'NOT_CONFIRMED',
      });
    });

    it('6. a delayed success after FAILED is recorded for review and never reactivates', async () => {
      const row = await startRow();
      await service.complete(user.id, row.id, 'RETURNED');
      const late = await notify(row, 2, { paymentId: '777001' });
      expect(late).toEqual({ alreadyHandled: true, lateAuthorization: true });
      expect(row).toMatchObject({
        status: SavedCardStatus.FAILED,
        authorizationEnabled: false,
        tokenCiphertext: null,
        tokenIv: null,
        tokenTag: null,
        openCardSlot: null,
        payherePaymentId: '777001',
      });
      expect(row.lateAuthorizationAt).toBeInstanceOf(Date);
      expect(savedCardIsChargeable(row)).toBe(false);
      const logged = errorSpy.mock.calls.map((call) => call[0] as { event?: string });
      expect(logged.map((entry) => entry.event)).toContain(
        'payhere.preapproval.notify.late_authorization',
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
      expect((await service.list(user.id)).methods).toEqual([]);
    });

    it('6b. a success that loses the race to complete is recorded, not activated', async () => {
      const row = await startRow();
      payhere.verifyPreapproval.mockReturnValue({
        ...verifiedSuccess(row.merchantReference),
        statusCode: 2,
      });
      // complete fails the row after handleNotify read it as PENDING.
      prisma.savedPaymentMethod.findUnique.mockImplementationOnce(async () => {
        const snapshot = { ...row };
        await service.complete(user.id, row.id, 'RETURNED');
        return snapshot;
      });
      await expect(
        service.handleNotify({ order_id: row.merchantReference }),
      ).resolves.toEqual({ alreadyHandled: true, lateAuthorization: true });
      expect(row.status).toBe(SavedCardStatus.FAILED);
      expect(row.tokenCiphertext).toBeNull();
      expect(row.lateAuthorizationAt).toBeInstanceOf(Date);
    });

    it('7. duplicate notifications and repeated completes are idempotent', async () => {
      const row = await startRow();
      await notify(row, 2);
      const ciphertext = row.tokenCiphertext;
      await expect(notify(row, 2)).resolves.toMatchObject({
        alreadyHandled: true,
      });
      await expect(notify(row, -2)).resolves.toMatchObject({
        alreadyHandled: true,
      });
      expect(row.status).toBe(SavedCardStatus.ACTIVE);
      expect(row.tokenCiphertext).toBe(ciphertext);
      const first = await service.complete(user.id, row.id, 'RETURNED');
      const second = await service.complete(user.id, row.id, 'CLOSED');
      expect(second).toEqual(first);

      const failed = await startRow();
      await service.complete(user.id, failed.id, 'RETURNED');
      await notify(failed, 2);
      const flaggedAt = failed.lateAuthorizationAt;
      errorSpy.mockClear();
      await expect(notify(failed, 2)).resolves.toMatchObject({
        alreadyHandled: true,
      });
      expect(failed.lateAuthorizationAt).toBe(flaggedAt);
      expect(errorSpy).not.toHaveBeenCalled();
      const failedAt = failed.failedAt;
      await service.complete(user.id, failed.id, 'CANCELLED');
      expect(failed.failedAt).toBe(failedAt);
      expect(failed.failureReason).toBe(SavedCardFailureReason.NOT_CONFIRMED);
    });

    it('8. a customer can retry immediately after FAILED', async () => {
      const first = await startRow();
      await service.complete(user.id, first.id, 'CLOSED');
      const retry = await startRow();
      expect(retry.id).not.toBe(first.id);
      expect(retry.status).toBe(SavedCardStatus.PENDING);
      await notify(retry, 2);
      await expect(
        service.complete(user.id, retry.id, 'RETURNED'),
      ).resolves.toMatchObject({ status: SavedCardStatus.ACTIVE });
      const listed = await service.list(user.id);
      expect(listed.methods.map((card) => card.id)).toEqual([retry.id]);
      expect(listed.failedRegistration).toBeNull();
      expect(
        events.filter(
          (event) => event.type === SavedCardConsentEventType.CONSENT_GRANTED,
        ),
      ).toHaveLength(2);
    });

    it('9. an existing ACTIVE card is unchanged by a failed or late registration', async () => {
      const active = await startRow();
      await notify(active, 2);
      const before = { ...active };
      const next = await startRow();
      await service.complete(user.id, next.id, 'RETURNED');
      await notify(next, 2);
      await notify(active, -2);
      await expect(
        service.complete(user.id, active.id, 'CANCELLED'),
      ).resolves.toMatchObject({ status: SavedCardStatus.ACTIVE });
      expect(active).toMatchObject({
        status: SavedCardStatus.ACTIVE,
        authorizationEnabled: true,
        tokenCiphertext: before.tokenCiphertext,
        failureReason: null,
        lateAuthorizationAt: null,
      });
      await expect(service.readActiveToken(user.id, active.id)).resolves.toBe(
        TOKEN,
      );
      expect((await service.list(user.id)).methods.map((c) => c.id)).toEqual([
        active.id,
      ]);
    });

    it('10. an older registration cannot interfere with a newer one', async () => {
      const older = await startRow();
      const newer = await startRow();
      expect(older).toMatchObject({
        status: SavedCardStatus.FAILED,
        failureReason: SavedCardFailureReason.SUPERSEDED,
        openCardSlot: null,
      });
      expect(openSlots().map((row) => row.id)).toEqual([newer.id]);

      await notify(older, 2);
      await notify(older, -2);
      await service.complete(user.id, older.id, 'CANCELLED');
      expect(older.status).toBe(SavedCardStatus.FAILED);
      expect(older.lateAuthorizationAt).toBeInstanceOf(Date);
      expect(newer).toMatchObject({
        status: SavedCardStatus.PENDING,
        openCardSlot: user.id,
        failureReason: null,
      });

      await notify(newer, 2);
      await expect(
        service.complete(user.id, newer.id, 'RETURNED'),
      ).resolves.toMatchObject({ status: SavedCardStatus.ACTIVE });
      expect(older.status).toBe(SavedCardStatus.FAILED);
      expect(older.tokenCiphertext).toBeNull();
    });

    it('11. every failure path releases openCardSlot', async () => {
      const declined = await startRow();
      await notify(declined, -2);
      expect(openSlots()).toEqual([]);
      const cancelled = await startRow();
      await service.complete(user.id, cancelled.id, 'CANCELLED');
      expect(openSlots()).toEqual([]);
      const unconfirmed = await startRow();
      await service.complete(user.id, unconfirmed.id, 'RETURNED');
      expect(openSlots()).toEqual([]);
      const superseded = await startRow();
      await startRow();
      expect(superseded.openCardSlot).toBeNull();
      expect(openSlots()).toHaveLength(1);
      await service.failAbandonedRegistrations(
        new Date(Date.now() + 365 * 24 * 60 * 60_000),
      );
      expect(openSlots()).toEqual([]);
    });

    it('12. no customer can remain persistently PENDING', async () => {
      const abandoned = await startRow();
      const createdAt = abandoned.createdAt.getTime();
      await expect(
        service.failAbandonedRegistrations(
          new Date(createdAt + (ABANDONED_REGISTRATION_MINUTES - 1) * 60_000),
        ),
      ).resolves.toEqual({ failed: 0 });
      expect(abandoned.status).toBe(SavedCardStatus.PENDING);
      // Even before the backstop, the customer is never blocked or shown PENDING.
      expect((await service.list(user.id)).pendingRegistration).toBeNull();

      await expect(
        service.failAbandonedRegistrations(
          new Date(createdAt + (ABANDONED_REGISTRATION_MINUTES + 1) * 60_000),
        ),
      ).resolves.toEqual({ failed: 1 });
      expect(abandoned).toMatchObject({
        status: SavedCardStatus.FAILED,
        failureReason: SavedCardFailureReason.ABANDONED,
        openCardSlot: null,
      });
      await expect(
        service.failAbandonedRegistrations(
          new Date(createdAt + 2 * ABANDONED_REGISTRATION_MINUTES * 60_000),
        ),
      ).resolves.toEqual({ failed: 0 });
      expect(cards.some((row) => row.status === SavedCardStatus.PENDING)).toBe(
        false,
      );
      expect(events).toHaveLength(1);
    });

    it('resolves legacy PENDING rows by id without touching other rows or consent history', async () => {
      const active = await startRow();
      await notify(active, 2);
      const legacy = await startRow();
      const eventCount = events.length;
      const result = await failStalePendingRegistrations(prisma as never, {
        createdBefore: new Date(legacy.createdAt.getTime() + 1),
        reason: SavedCardFailureReason.LEGACY_PENDING,
        now: new Date(),
        ids: [legacy.id, active.id],
      });
      expect(result).toEqual({ failed: 1 });
      expect(legacy).toMatchObject({
        status: SavedCardStatus.FAILED,
        failureReason: SavedCardFailureReason.LEGACY_PENDING,
        openCardSlot: null,
      });
      expect(active.status).toBe(SavedCardStatus.ACTIVE);
      expect(events).toHaveLength(eventCount);
    });

    it('rejects completing another customer\'s registration', async () => {
      const row = await startRow();
      await expect(
        service.complete('someone-else', row.id, 'RETURNED'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(row.status).toBe(SavedCardStatus.PENDING);
    });
  });
});

describe('SavedCardService preapproval notify diagnostics', () => {
  const cards: SavedPaymentMethod[] = [];
  const events: SavedCardConsentEvent[] = [];
  let seq = 0;
  const crypto = new BankAccountCrypto({
    getOrThrow: () => 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
  } as never);
  const payhere = {
    createPreapproval: jest.fn(),
    verifyPreapproval: jest.fn(),
  };
  const user = {
    id: 'user-diag',
    role: UserRole.PUBLIC,
    phone: '+94770001111',
    name: 'Diag',
    billingFirstName: 'Diag',
    billingLastName: 'User',
    billingEmail: 'diag@example.com',
    billingAddress: '1 Road',
    billingCity: 'Colombo',
    billingCountry: 'LK',
  } as User;

  const prisma = {
    savedPaymentMethod: {
      findUnique: jest.fn(async ({ where }: { where: { merchantReference?: string; id?: string } }) => {
        if (where.merchantReference) {
          return cards.find((row) => row.merchantReference === where.merchantReference) ?? null;
        }
        return cards.find((row) => row.id === where.id) ?? null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = cards.find((item) => item.id === where.id);
        if (!row) throw new Error('missing');
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: SavedCardStatus };
          data: Partial<SavedPaymentMethod>;
        }) => {
          const row = cards.find(
            (item) =>
              item.id === where.id &&
              (where.status === undefined || item.status === where.status),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work(prisma),
    ),
  };

  const service = new SavedCardService(prisma as never, payhere, crypto, null);
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    cards.splice(0, cards.length);
    events.splice(0, events.length);
    seq = 0;
    jest.clearAllMocks();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function pendingCard() {
    seq += 1;
    const row = {
      id: `card-${seq}`,
      userId: user.id,
      provider: PaymentProvider.PAYHERE,
      status: SavedCardStatus.PENDING,
      merchantReference: `pa_diag_${seq}`,
      payherePaymentId: null,
      tokenCiphertext: null,
      tokenIv: null,
      tokenTag: null,
      cardBrand: null,
      cardLast4: null,
      consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
      consentedAt: new Date(),
      authorizationEnabled: false,
      revokedAt: null,
      removedAt: null,
      openCardSlot: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as SavedPaymentMethod;
    cards.push(row);
    return row;
  }

  function rendered() {
    return JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
  }

  it('logs activation without tokens or card secrets', async () => {
    const row = pendingCard();
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: row.merchantReference,
      providerPaymentId: '9002',
      statusCode: 2,
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: 'VISA',
      cardLast4: '4564',
    });
    await service.handleNotify({
      order_id: row.merchantReference,
      customer_token: TOKEN,
      card_no: '************4564',
      md5sig: 'should-not-log',
    });
    expect(
      logSpy.mock.calls.some(
        (call) =>
          (call[0] as { event?: string }).event ===
          'payhere.preapproval.notify.activated',
      ),
    ).toBe(true);
    expect(payHereLogContainsForbidden(rendered(), [TOKEN, 'should-not-log'])).toBeNull();
    expect(rendered()).not.toContain(TOKEN);
    expect(rendered()).not.toContain('************4564');
  });

  it('logs a failed registration', async () => {
    const row = pendingCard();
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: row.merchantReference,
      providerPaymentId: '9001',
      statusCode: -1,
      outcome: 'failed',
      success: false,
      customerToken: null,
      cardBrand: null,
      cardLast4: null,
    });
    await service.handleNotify({ order_id: row.merchantReference });
    expect(
      logSpy.mock.calls.some(
        (call) =>
          (call[0] as { event?: string }).event ===
            'payhere.preapproval.notify.failed' &&
          (call[0] as { statusCode?: number }).statusCode === -1,
      ),
    ).toBe(true);
  });

  it('logs an invalid signature', async () => {
    payhere.verifyPreapproval.mockImplementation(() => {
      throw new PayHereNotificationError('Invalid signature');
    });
    await expect(
      service.handleNotify({ order_id: 'pa_bad', md5sig: '00' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      warnSpy.mock.calls.some(
        (call) =>
          (call[0] as { event?: string }).event ===
          'payhere.preapproval.notify.invalid_signature',
      ),
    ).toBe(true);
  });

  it('logs an unknown reference', async () => {
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: 'pa_missing',
      providerPaymentId: '',
      statusCode: 2,
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: null,
      cardLast4: null,
    });
    await expect(service.handleNotify({ order_id: 'pa_missing' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      warnSpy.mock.calls.some(
        (call) =>
          (call[0] as { event?: string }).event ===
          'payhere.preapproval.notify.unknown_reference',
      ),
    ).toBe(true);
  });

  it('logs a duplicate callback for an already-active card', async () => {
    const row = pendingCard();
    row.status = SavedCardStatus.ACTIVE;
    row.openCardSlot = null;
    payhere.verifyPreapproval.mockReturnValue({
      merchantReference: row.merchantReference,
      providerPaymentId: '9002',
      statusCode: 2,
      outcome: 'success',
      success: true,
      customerToken: TOKEN,
      cardBrand: 'VISA',
      cardLast4: '1111',
    });
    await service.handleNotify({ order_id: row.merchantReference });
    expect(
      logSpy.mock.calls.some(
        (call) =>
          (call[0] as { event?: string }).event ===
          'payhere.preapproval.notify.duplicate',
      ),
    ).toBe(true);
  });
});

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentProvider,
  Prisma,
  SavedCardConsentEventType,
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
import { SavedCardService } from './saved-card.service';

const TOKEN = '59AFEE022CC69CA39D325E1B59130862';

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
      findMany: jest.fn(async ({ where }: { where?: { userId?: string } }) =>
        cards.filter((row) => !where?.userId || row.userId === where.userId),
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { openCardSlot?: string; id?: string; userId?: string };
        }) =>
          cards.find(
            (row) =>
              (where.openCardSlot === undefined ||
                row.openCardSlot === where.openCardSlot) &&
              (where.id === undefined || row.id === where.id) &&
              (where.userId === undefined || row.userId === where.userId),
          ) ?? null,
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
          where: {
            id: string;
            userId?: string;
            status?: SavedCardStatus | { in?: SavedCardStatus[]; not?: SavedCardStatus };
          };
          data: Partial<SavedPaymentMethod>;
        }) => {
          const row = cards.find((item) => item.id === where.id);
          if (!row) return { count: 0 };
          if (where.userId && row.userId !== where.userId) return { count: 0 };
          const status = where.status;
          if (typeof status === 'string' && row.status !== status) return { count: 0 };
          if (
            status &&
            typeof status === 'object' &&
            status.in &&
            !status.in.includes(row.status)
          ) {
            return { count: 0 };
          }
          if (
            status &&
            typeof status === 'object' &&
            status.not &&
            row.status === status.not
          ) {
            return { count: 0 };
          }
          Object.assign(row, data, { updatedAt: new Date() });
          return { count: 1 };
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
  );

  beforeEach(() => {
    cards.splice(0, cards.length);
    events.splice(0, events.length);
    seq = 0;
    jest.clearAllMocks();
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
});

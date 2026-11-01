import {
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  PaymentStatus,
  Prisma,
  RefundObligation,
  UserRole,
} from '@prisma/client';
import { PayHereChargeNotSentError } from './payhere/payhere.gateway';
import { SavedCardChargeService } from './saved-card-charge.service';

const TOKEN = 'SECRET-CUSTOMER-TOKEN';

describe('SavedCardChargeService', () => {
  const user = {
    id: 'cust-1',
    role: UserRole.PUBLIC,
    name: 'Nimal',
    phone: '+94771234567',
    billingFirstName: 'Nimal',
    billingLastName: 'Perera',
    billingEmail: 'nimal@example.com',
    billingAddress: '12 Temple Road',
    billingCity: 'Colombo',
    billingCountry: 'Sri Lanka',
  };
  const consultation = {
    id: 'c-1',
    customerId: 'cust-1',
    astrologerId: 'ap-1',
    status: 'ACCEPTED',
    requestedPrice: '1500.00',
  };
  const proposal = {
    id: 'p-1',
    status: 'ACCEPTED',
    proposedStartAt: new Date('2026-10-01T04:30:00.000Z'),
    proposedEndAt: new Date('2026-10-01T05:00:00.000Z'),
    durationMinutes: 30,
  };
  const card = {
    id: 'card-1',
    userId: 'cust-1',
    status: 'ACTIVE',
    authorizationEnabled: true,
    revokedAt: null,
    removedAt: null,
    tokenCiphertext: 'cipher',
    tokenIv: 'iv',
    tokenTag: 'tag',
    consentVersion: '2026-11-01',
  };

  const tx = {
    appointment: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: { create: jest.fn(), update: jest.fn() },
    paymentAttempt: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  };
  const prisma = {
    consultation: { findUnique: jest.fn() },
    consultationProposal: { findFirst: jest.fn() },
    savedPaymentMethod: { findFirst: jest.fn() },
    savedCardConsentEvent: { findFirst: jest.fn() },
    paymentAttempt: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    appointment: { findUniqueOrThrow: jest.fn() },
    $queryRaw: jest.fn(async () => [{ id: 'card-1' }]),
    $transaction: jest.fn(async (work: (tx: typeof prisma) => Promise<unknown>) =>
      work(prisma),
    ),
  };
  const occupancy = {
    expireDueReservations: jest.fn(),
    loadOccupiedIntervals: jest.fn().mockResolvedValue([]),
  };
  const availability = { assertProposedSlotEligible: jest.fn() };
  const bookingGuard = {
    withAstrologerLock: jest.fn(
      async (_id: string, work: (client: typeof tx) => unknown) => work(tx),
    ),
  };
  const savedCards = { readActiveToken: jest.fn() };
  const payments = { finalizeVerified: jest.fn() };
  const payhere = {
    hasMerchantCapacity: jest.fn(() => true),
    chargePayment: jest.fn(),
    verifyByReference: jest.fn(),
  };
  const service = new SavedCardChargeService(
    prisma as never,
    availability as never,
    occupancy as never,
    bookingGuard as never,
    savedCards as never,
    payments as never,
    payhere as never,
  );

  function readyAppointment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'apt-1',
      status: AppointmentStatus.PAYMENT_PENDING,
      refundObligation: null,
      payments: [
        {
          id: 'pay-1',
          status: PaymentStatus.PENDING,
          attempts: [
            {
              id: 'att-1',
              merchantReference: 'sc_existing',
              status: PaymentStatus.PENDING,
              requiresReview: false,
              openChargeSlot: null,
              createdAt: new Date('2026-10-01T00:00:00.000Z'),
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.consultation.findUnique.mockResolvedValue(consultation);
    prisma.consultationProposal.findFirst.mockResolvedValue(proposal);
    prisma.savedPaymentMethod.findFirst.mockResolvedValue(card);
    prisma.savedCardConsentEvent.findFirst.mockImplementation(
      async ({ where }: { where: { type: string } }) =>
        where.type === 'CONSENT_REVOKED' ? null : { id: 'grant' },
    );
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.appointment.findUnique.mockResolvedValue(null);
    tx.appointment.create.mockResolvedValue({
      id: 'apt-1',
      status: AppointmentStatus.PAYMENT_PENDING,
      refundObligation: null,
      payments: [],
    });
    tx.payment.create.mockResolvedValue({
      id: 'pay-1',
      status: PaymentStatus.PENDING,
      attempts: [],
    });
    tx.paymentAttempt.create.mockImplementation(
      async ({ data }: { data: { merchantReference: string } }) => ({
        id: 'att-1',
        ...data,
      }),
    );
    savedCards.readActiveToken.mockResolvedValue(TOKEN);
    payhere.hasMerchantCapacity.mockReturnValue(true);
    payhere.chargePayment.mockImplementation(
      async (
        _input: unknown,
        hooks?: { beforeDispatch?: () => Promise<boolean> },
      ) => {
        if (hooks?.beforeDispatch) {
          const allowed = await hooks.beforeDispatch();
          if (!allowed) throw new PayHereChargeNotSentError();
        }
        return {
          kind: 'reported',
          statusCode: 2,
          providerPaymentId: '320025014001',
          amount: '1500.00',
          currency: 'LKR',
        };
      },
    );
    payhere.verifyByReference.mockResolvedValue({
      success: true,
      pending: false,
      ambiguous: false,
      providerPaymentId: '320025014001',
      amount: '1500.00',
      currency: 'LKR',
    });
    payments.finalizeVerified.mockResolvedValue({});
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        status: AppointmentStatus.CONFIRMED,
        payments: [
          {
            id: 'pay-1',
            status: PaymentStatus.PAID,
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_done',
                status: PaymentStatus.PAID,
                requiresReview: false,
                openChargeSlot: null,
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
  });

  it('charges an active authorized card once and hides the token', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(payhere.chargePayment.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        amount: '1500.00',
        currency: 'LKR',
        customerToken: TOKEN,
      }),
    );
    const orderId = payhere.chargePayment.mock.calls[0][0].orderId as string;
    expect(orderId).toMatch(/^sc_[a-f0-9]+$/);
    const stored = JSON.stringify(tx.paymentAttempt.create.mock.calls);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain('merchant-secret');
    expect(stored).not.toContain('oauth-access-secret');
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view).toMatchObject({
      provider: 'PAYHERE',
      attemptStatus: PaymentStatus.PAID,
      appointmentStatus: AppointmentStatus.CONFIRMED,
      reconciliationRequired: false,
    });
    expect(payments.finalizeVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        amount: '1500.00',
        currency: 'LKR',
        providerPaymentId: '320025014001',
      }),
    );
    expect(log.mock.calls.join(' ')).not.toContain(TOKEN);
    log.mockRestore();
  });

  it.each([
    ['missing card', null],
    [
      'disabled card',
      { ...card, status: 'DISABLED', authorizationEnabled: false },
    ],
    ['removed card', { ...card, status: 'REMOVED', removedAt: new Date() }],
    ['revoked card', { ...card, revokedAt: new Date(), authorizationEnabled: false }],
    ['missing token', { ...card, tokenCiphertext: null }],
    ['old consent', { ...card, consentVersion: '2020-01-01' }],
  ])('rejects a %s before reserving', async (_label, row) => {
    prisma.savedPaymentMethod.findFirst.mockResolvedValue(row);
    await expect(service.charge(user as never, 'c-1', 'p-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(bookingGuard.withAstrologerLock).not.toHaveBeenCalled();
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('rejects revoked consent and another customer’s card', async () => {
    prisma.savedCardConsentEvent.findFirst.mockResolvedValue({ id: 'revoked' });
    await expect(service.charge(user as never, 'c-1', 'p-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.savedPaymentMethod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'cust-1' }) }),
    );
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('releases the attempt when the token cannot be decrypted', async () => {
    savedCards.readActiveToken.mockRejectedValue(
      new Error(`decrypt failed ${TOKEN}`),
    );
    await expect(service.charge(user as never, 'c-1', 'p-1')).rejects.toThrow(
      /authorized for automatic payment/,
    );
    expect(payhere.chargePayment).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.FAILED,
          openChargeSlot: null,
        }),
      }),
    );
    expect(JSON.stringify(prisma.paymentAttempt.updateMany.mock.calls)).not.toContain(
      TOKEN,
    );
  });

  it('does not confirm pending, declined, or rejected charges', async () => {
    payhere.verifyByReference.mockResolvedValue({ success: false, pending: true });
    payhere.chargePayment.mockResolvedValue({ kind: 'uncertain' });
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const pending = await service.charge(user as never, 'c-1', 'p-1');
    expect(pending.reconciliationRequired).toBe(true);
    expect(pending.appointmentStatus).not.toBe(AppointmentStatus.CONFIRMED);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();

    payhere.chargePayment.mockResolvedValue({ kind: 'declined', statusCode: -1 });
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const declined = await service.charge(user as never, 'c-1', 'p-1');
    expect(declined.attemptStatus).toBe(PaymentStatus.PENDING);
    expect(declined.reconciliationRequired).toBe(true);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();
  });

  it('returns an open attempt instead of charging again', async () => {
    tx.appointment.findUnique.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(view.reconciliationRequired).toBe(true);
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('does not charge again after a timeout or a restart', async () => {
    tx.appointment.findUnique.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: false,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(view.reconciliationRequired).toBe(true);
    expect(tx.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { requiresReview: true } }),
    );
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('a concurrent unique conflict does not send a second charge', async () => {
    tx.paymentAttempt.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    tx.paymentAttempt.findFirst.mockResolvedValue({
      id: 'att-open',
      merchantReference: 'sc_winner',
      status: PaymentStatus.PENDING,
      requiresReview: false,
      openChargeSlot: 'pay-1',
      createdAt: new Date(),
    });
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(view.merchantReference).toBe('sc_winner');
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('finalizes one matching retrieval and leaves an ambiguous one unresolved', async () => {
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'att-1',
      merchantReference: 'sc_existing',
      requiresReview: true,
      openChargeSlot: 'pay-1',
      providerPaymentId: '222',
      payment: {
        amount: '1500.00',
        currency: 'LKR',
        appointmentId: 'apt-1',
      },
    });
    payhere.verifyByReference.mockResolvedValueOnce({
      success: false,
      pending: true,
    });
    payhere.verifyByReference.mockResolvedValueOnce({
      success: false,
      ambiguous: true,
    });
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const missing = await service.reconcileOne('att-1');
    const ambiguous = await service.reconcileOne('att-1');
    expect(missing.reconciliationRequired).toBe(true);
    expect(ambiguous.reconciliationRequired).toBe(true);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();

    payhere.verifyByReference.mockResolvedValueOnce({
      success: true,
      ambiguous: false,
      providerPaymentId: '222',
      amount: '1500.00',
      currency: 'LKR',
    });
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({ status: AppointmentStatus.CONFIRMED }),
    );
    await service.reconcileOne('att-1');
    expect(payments.finalizeVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantReference: 'sc_existing',
        providerPaymentId: '222',
        success: true,
      }),
    );
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('keeps a late capture on the existing refund path and does not confirm it', async () => {
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        status: AppointmentStatus.PAYMENT_EXPIRED,
        refundObligation: RefundObligation.FULL_REFUND_DUE,
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_late',
                status: PaymentStatus.PAID,
                requiresReview: false,
                openChargeSlot: null,
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(payments.finalizeVerified).toHaveBeenCalledTimes(1);
    expect(view.appointmentStatus).toBe(AppointmentStatus.PAYMENT_EXPIRED);
    expect(view.refundObligation).toBe(RefundObligation.FULL_REFUND_DUE);
    expect(view.appointmentStatus).not.toBe(AppointmentStatus.CONFIRMED);
  });

  it('does not mark an in-flight charge canceled when the card is revoked afterward', async () => {
    payhere.verifyByReference.mockResolvedValue({ success: false, pending: true });
    payhere.chargePayment.mockImplementation(
      async (
        _input: unknown,
        hooks?: { beforeDispatch?: () => Promise<boolean> },
      ) => {
        const allowed = await hooks?.beforeDispatch?.();
        expect(allowed).toBe(true);
        prisma.savedPaymentMethod.findFirst.mockResolvedValue({
          ...card,
          status: 'DISABLED',
          authorizationEnabled: false,
          revokedAt: new Date(),
          tokenCiphertext: null,
        });
        prisma.savedCardConsentEvent.findFirst.mockResolvedValue({ id: 'revoked' });
        return { kind: 'uncertain' };
      },
    );
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(view.attemptStatus).toBe(PaymentStatus.PENDING);
    expect(view.reconciliationRequired).toBe(true);
    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { requiresReview: true } }),
    );
    expect(prisma.paymentAttempt.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.FAILED }),
      }),
    );
  });

  it('rejects a non-public customer and does not charge without PayHere', async () => {
    await expect(
      service.charge(
        { ...user, role: UserRole.ASTROLOGER } as never,
        'c-1',
        'p-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const unavailable = new SavedCardChargeService(
      prisma as never,
      availability as never,
      occupancy as never,
      bookingGuard as never,
      savedCards as never,
      payments as never,
      null,
    );
    await expect(unavailable.charge(user as never, 'c-1', 'p-1')).rejects.toThrow(
      /PAYHERE_MODE/,
    );
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('requires an accepted proposal before it reserves or charges', async () => {
    prisma.consultationProposal.findFirst.mockResolvedValue({
      ...proposal,
      status: 'PENDING',
    });
    await expect(service.charge(user as never, 'c-1', 'p-1')).rejects.toThrow(
      /proposal/,
    );
    expect(bookingGuard.withAstrologerLock).not.toHaveBeenCalled();
    expect(payhere.chargePayment).not.toHaveBeenCalled();
  });

  it('stops before the lock when PayHere has no capacity', async () => {
    payhere.hasMerchantCapacity.mockReturnValue(false);
    await expect(service.charge(user as never, 'c-1', 'p-1')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(bookingGuard.withAstrologerLock).not.toHaveBeenCalled();
  });

  it.each([
    ['no matching payment', { success: false, pending: true }],
    ['several matching payments', { success: false, pending: true, ambiguous: true }],
    ['an amount mismatch', { success: false, pending: true }],
    ['a currency mismatch', { success: false, pending: true }],
    ['a chargeback', { success: false, pending: true }],
    ['a retrieval timeout', { success: false, pending: true }],
  ])(
    'keeps a synchronous status 2 unresolved when retrieval reports %s',
    async (_label, retrieval) => {
      payhere.verifyByReference.mockResolvedValue(retrieval);
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        readyAppointment({
          payments: [
            {
              attempts: [
                {
                  id: 'att-1',
                  merchantReference: 'sc_existing',
                  status: PaymentStatus.PENDING,
                  requiresReview: true,
                  openChargeSlot: 'pay-1',
                  createdAt: new Date(),
                },
              ],
            },
          ],
        }),
      );
      const view = await service.charge(user as never, 'c-1', 'p-1');
      expect(view.reconciliationRequired).toBe(true);
      expect(view.attemptStatus).not.toBe(PaymentStatus.PAID);
      expect(payments.finalizeVerified).not.toHaveBeenCalled();
      expect(payhere.chargePayment).toHaveBeenCalledTimes(1);
      expect(payhere.verifyByReference).toHaveBeenCalledWith(
        expect.stringMatching(/^sc_/),
        expect.objectContaining({
          amount: '1500.00',
          currency: 'LKR',
          providerPaymentId: '320025014001',
        }),
      );
    },
  );

  it('finalizes only one retrieval match and does not charge again to check it', async () => {
    await service.charge(user as never, 'c-1', 'p-1');
    expect(payments.finalizeVerified).toHaveBeenCalledTimes(1);
    expect(payments.finalizeVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPaymentId: '320025014001',
        amount: '1500.00',
        currency: 'LKR',
        raw: { source: 'saved-card-retrieval' },
      }),
    );
    expect(payhere.chargePayment).toHaveBeenCalledTimes(1);
    expect(payhere.verifyByReference).toHaveBeenCalledTimes(1);
  });

  it('does not finalize a missing or mismatched synchronous signature on its own', async () => {
    payhere.chargePayment.mockResolvedValue({ kind: 'uncertain' });
    payhere.verifyByReference.mockResolvedValue({ success: false, pending: true });
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(view.reconciliationRequired).toBe(true);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();
    expect(payhere.chargePayment).toHaveBeenCalledTimes(1);
  });

  it('can confirm a bad synchronous signature only through one retrieval match', async () => {
    payhere.chargePayment.mockResolvedValue({ kind: 'uncertain' });
    await service.charge(user as never, 'c-1', 'p-1');
    expect(payments.finalizeVerified).toHaveBeenCalledTimes(1);
    expect(payhere.chargePayment).toHaveBeenCalledTimes(1);
    expect(payhere.verifyByReference).toHaveBeenCalledWith(
      expect.stringMatching(/^sc_/),
      expect.objectContaining({
        amount: '1500.00',
        currency: 'LKR',
        providerPaymentId: undefined,
      }),
    );
  });

  it('does not call PayHere when revocation wins before dispatch authorization', async () => {
    let posted = false;
    payhere.chargePayment.mockImplementation(
      async (
        _input: unknown,
        hooks?: { beforeDispatch?: () => Promise<boolean> },
      ) => {
        prisma.savedPaymentMethod.findFirst.mockResolvedValue({
          ...card,
          status: 'DISABLED',
          authorizationEnabled: false,
          revokedAt: new Date(),
          tokenCiphertext: null,
        });
        prisma.savedCardConsentEvent.findFirst.mockResolvedValue({ id: 'revoked' });
        const allowed = await hooks?.beforeDispatch?.();
        if (!allowed) throw new PayHereChargeNotSentError();
        posted = true;
        return { kind: 'uncertain' };
      },
    );
    await expect(service.charge(user as never, 'c-1', 'p-1')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(posted).toBe(false);
    expect(payhere.verifyByReference).not.toHaveBeenCalled();
    expect(payments.finalizeVerified).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.FAILED,
          openChargeSlot: null,
        }),
      }),
    );
  });

  it('keeps an authorized dispatch in flight when revocation happens after it', async () => {
    let posted = false;
    payhere.verifyByReference.mockResolvedValue({ success: false, pending: true });
    payhere.chargePayment.mockImplementation(
      async (
        _input: unknown,
        hooks?: { beforeDispatch?: () => Promise<boolean> },
      ) => {
        const allowed = await hooks?.beforeDispatch?.();
        expect(allowed).toBe(true);
        prisma.savedPaymentMethod.findFirst.mockResolvedValue({
          ...card,
          status: 'DISABLED',
          authorizationEnabled: false,
          revokedAt: new Date(),
          tokenCiphertext: null,
        });
        posted = true;
        return { kind: 'reported', statusCode: 2, providerPaymentId: '320025014001', amount: '1500.00', currency: 'LKR' };
      },
    );
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const view = await service.charge(user as never, 'c-1', 'p-1');
    expect(posted).toBe(true);
    expect(view.attemptStatus).toBe(PaymentStatus.PENDING);
    expect(view.reconciliationRequired).toBe(true);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.FAILED }),
      }),
    );
    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checkoutPayload: expect.objectContaining({
            dispatchAuthorizedAt: expect.any(String),
          }),
        }),
      }),
    );
  });

  it('lets a revocation that commits first block dispatch', async () => {
    let posted = false;
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let chain = Promise.resolve();
    let opened = 0;
    prisma.$transaction.mockImplementation(
      (work: (tx: typeof prisma) => Promise<unknown>) => {
        const place = ++opened;
        const run = chain.then(async () => {
          if (place === 1) await hold;
          return work(prisma);
        });
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    );
    const revokeFirst = prisma.$transaction(async () => {
      prisma.savedPaymentMethod.findFirst.mockResolvedValue({
        ...card,
        status: 'DISABLED',
        authorizationEnabled: false,
        revokedAt: new Date(),
        tokenCiphertext: null,
      });
      prisma.savedCardConsentEvent.findFirst.mockResolvedValue({ id: 'revoked' });
    });
    let enteredCharge: () => void = () => undefined;
    const chargeEntered = new Promise<void>((resolve) => {
      enteredCharge = resolve;
    });
    payhere.chargePayment.mockImplementation(
      async (
        _input: unknown,
        hooks?: { beforeDispatch?: () => Promise<boolean> },
      ) => {
        enteredCharge();
        const allowed = await hooks?.beforeDispatch?.();
        if (!allowed) throw new PayHereChargeNotSentError();
        posted = true;
        return { kind: 'uncertain' };
      },
    );
    const chargePromise = service.charge(user as never, 'c-1', 'p-1');
    await chargeEntered;
    releaseHold();
    await revokeFirst;
    await expect(chargePromise).rejects.toBeInstanceOf(HttpException);
    expect(posted).toBe(false);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();
  });

  it('does not send a second charge when retrieval fails or the process restarts', async () => {
    payhere.verifyByReference.mockRejectedValue(new Error('timeout'));
    prisma.appointment.findUniqueOrThrow.mockResolvedValue(
      readyAppointment({
        payments: [
          {
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'sc_existing',
                status: PaymentStatus.PENDING,
                requiresReview: true,
                openChargeSlot: 'pay-1',
                createdAt: new Date(),
              },
            ],
          },
        ],
      }),
    );
    const timedOut = await service.charge(user as never, 'c-1', 'p-1');
    expect(timedOut.reconciliationRequired).toBe(true);
    expect(payments.finalizeVerified).not.toHaveBeenCalled();
    expect(payhere.chargePayment).toHaveBeenCalledTimes(1);

    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'att-1',
      merchantReference: 'sc_existing',
      requiresReview: true,
      openChargeSlot: 'pay-1',
      providerPaymentId: null,
      payment: {
        amount: '1500.00',
        currency: 'LKR',
        appointmentId: 'apt-1',
      },
    });
    payhere.verifyByReference.mockResolvedValue({ success: false, pending: true });
    await service.reconcileOne('att-1');
    expect(payhere.chargePayment).toHaveBeenCalledTimes(1);
  });
});

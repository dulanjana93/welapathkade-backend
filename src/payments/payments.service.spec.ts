import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  RefundObligation,
  UserRole,
} from '@prisma/client';
import { PaymentsService } from './payments.service';
import { evaluateSettlementEligibility } from '../settlement/settlement-eligibility';

describe('PaymentsService.finalizeVerified', () => {
  // Transaction client used by recordFailure (failure callbacks).
  const failureTx = {
    paymentAttempt: { updateMany: jest.fn(), count: jest.fn() },
    payment: { updateMany: jest.fn() },
    appointment: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
  };
  const prisma = {
    paymentAttempt: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { updateMany: jest.fn() },
    appointment: { findUniqueOrThrow: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(async (work: (t: unknown) => unknown) =>
      work(failureTx),
    ),
  };
  const availability = {};
  const occupancy = { expireDueReservations: jest.fn() };
  const bookingGuard = {
    withAstrologerLock: jest.fn(
      async (_id: string, work: (tx: unknown) => unknown) => work(tx),
    ),
  };
  const gateway = {};
  const tx = {
    appointment: {
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    payment: { updateMany: jest.fn() },
    paymentAttempt: { updateMany: jest.fn() },
  };

  const notifications = {
    notifyUser: jest.fn().mockResolvedValue('n-customer'),
    notifyAstrologerProfile: jest.fn().mockResolvedValue('n-astrologer'),
    deliverAfterCommit: jest.fn(),
  };

  const service = new PaymentsService(
    prisma as never,
    availability as never,
    occupancy as never,
    bookingGuard as never,
    gateway as never,
    notifications as never,
  );

  // True once the (mock) lock/transaction callback has completed.
  const lock = { done: false };

  const appointment = {
    id: 'apt-1',
    consultationId: 'c-1',
    proposalId: 'p-1',
    customerId: 'cust-1',
    astrologerId: 'ap-1',
    status: AppointmentStatus.PAYMENT_PENDING,
    amount: '1500.00',
    currency: 'LKR',
    reservationExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
    startAt: new Date('2026-10-01T04:30:00.000Z'),
    endAt: new Date('2026-10-01T05:00:00.000Z'),
    durationMinutes: 30,
    confirmedAt: null,
    payments: [],
  };

  const attempt = {
    id: 'att-1',
    merchantReference: 'wp_ref',
    providerPaymentId: null,
    status: PaymentStatus.PENDING,
    payment: {
      id: 'pay-1',
      status: PaymentStatus.PENDING,
      appointment,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.paymentAttempt.findUnique.mockResolvedValue(attempt);
    prisma.paymentAttempt.update.mockResolvedValue(attempt);
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.appointment.findUniqueOrThrow.mockResolvedValue({
      ...appointment,
      payments: [],
    });
    tx.appointment.updateMany.mockResolvedValue({ count: 1 });
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
    tx.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    failureTx.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    failureTx.paymentAttempt.count.mockResolvedValue(0);
    failureTx.payment.updateMany.mockResolvedValue({ count: 1 });
    failureTx.appointment.updateMany.mockResolvedValue({ count: 1 });
    failureTx.appointment.findUniqueOrThrow.mockResolvedValue({
      ...appointment,
      status: AppointmentStatus.PAYMENT_EXPIRED,
      refundObligation: 'FULL_REFUND_DUE',
      payments: [],
    });
    tx.appointment.findUniqueOrThrow.mockResolvedValue({
      ...appointment,
      status: AppointmentStatus.CONFIRMED,
      payments: [
        {
          id: 'pay-1',
          status: PaymentStatus.PAID,
          provider: 'MOCK',
          amount: '1500.00',
          currency: 'LKR',
          paidAt: new Date(),
          attempts: [],
        },
      ],
    });
    lock.done = false;
    bookingGuard.withAstrologerLock.mockImplementation(
      async (_id: string, work: (client: unknown) => unknown) => {
        const result = await work(tx);
        lock.done = true;
        return result;
      },
    );
  });

  it('confirms when amount and currency match', async () => {
    const result = await service.finalizeVerified({
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500.00',
      currency: 'LKR',
      success: true,
    });
    expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
    expect(tx.appointment.updateMany).toHaveBeenCalled();
  });

  it('compares amounts as exact decimals, not strings', async () => {
    const result = await service.finalizeVerified({
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500',
      currency: 'LKR',
      success: true,
    });
    expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
  });

  describe('amount and currency are mandatory on success', () => {
    it.each([
      ['amount', { amount: '' }],
      ['currency', { currency: '' }],
    ])(
      'refuses a success without %s and changes nothing',
      async (_n, patch) => {
        await expect(
          service.finalizeVerified({
            merchantReference: 'wp_ref',
            providerPaymentId: 'mock_wp_ref',
            amount: '1500.00',
            currency: 'LKR',
            success: true,
            ...patch,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.appointment.updateMany).not.toHaveBeenCalled();
        expect(tx.payment.updateMany).not.toHaveBeenCalled();
        expect(prisma.paymentAttempt.updateMany).not.toHaveBeenCalled();
        expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      },
    );

    it('refuses an unparsable amount as a mismatch', async () => {
      await expect(
        service.finalizeVerified({
          merchantReference: 'wp_ref',
          providerPaymentId: 'mock_wp_ref',
          amount: 'not-a-number',
          currency: 'LKR',
          success: true,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a currency mismatch', async () => {
      await expect(
        service.finalizeVerified({
          merchantReference: 'wp_ref',
          providerPaymentId: 'mock_wp_ref',
          amount: '1500.00',
          currency: 'USD',
          success: true,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('callback ordering', () => {
    const success = {
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500.00',
      currency: 'LKR',
      success: true,
    };

    it('failure callback fails the attempt and the payment atomically', async () => {
      const result = await service.finalizeVerified({
        ...success,
        success: false,
      });
      expect(result.failed).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(failureTx.paymentAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      expect(failureTx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      // A failure never confirms or touches the appointment.
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('failure leaves the payment PENDING while another attempt is still pending', async () => {
      failureTx.paymentAttempt.count.mockResolvedValue(1);
      await service.finalizeVerified({ ...success, success: false });
      expect(failureTx.paymentAttempt.updateMany).toHaveBeenCalled();
      expect(failureTx.payment.updateMany).not.toHaveBeenCalled();
    });

    it('a repeated failure only ever targets PENDING rows (idempotent)', async () => {
      failureTx.paymentAttempt.updateMany.mockResolvedValue({ count: 0 });
      await service.finalizeVerified({ ...success, success: false });
      for (const call of failureTx.paymentAttempt.updateMany.mock
        .calls as Array<[{ where: { status: PaymentStatus } }]>) {
        expect(call[0].where.status).toBe(PaymentStatus.PENDING);
      }
      for (const call of failureTx.payment.updateMany.mock.calls as Array<
        [{ where: { status: PaymentStatus } }]
      >) {
        expect(call[0].where.status).toBe(PaymentStatus.PENDING);
      }
    });

    it('success after failure: a FAILED payment/attempt is paid together with the confirmation', async () => {
      prisma.paymentAttempt.findUnique.mockResolvedValue({
        ...attempt,
        status: PaymentStatus.FAILED,
        payment: { ...attempt.payment, status: PaymentStatus.FAILED },
      });
      const result = await service.finalizeVerified(success);
      expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'pay-1',
          status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
        },
        data: { status: PaymentStatus.PAID, paidAt: expect.any(Date) as Date },
      });
      expect(tx.paymentAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'att-1',
            status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          },
          data: expect.objectContaining({
            openChargeSlot: null,
            requiresReview: false,
          }),
        }),
      );
    });

    it('success then failure: PAID is terminal and the late failure changes nothing', async () => {
      prisma.paymentAttempt.findUnique.mockResolvedValue({
        ...attempt,
        payment: { ...attempt.payment, status: PaymentStatus.PAID },
      });
      const result = await service.finalizeVerified({
        ...success,
        success: false,
      });
      expect(result.alreadyPaid).toBe(true);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(failureTx.paymentAttempt.updateMany).not.toHaveBeenCalled();
      expect(failureTx.payment.updateMany).not.toHaveBeenCalled();
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('never leaves CONFIRMED without PAID: a non-payable payment aborts the transaction', async () => {
      tx.payment.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.finalizeVerified(success)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The thrown error propagates out of the lock transaction, which rolls
      // back the guarded confirmation; nothing is notified or delivered.
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });
  });

  describe('sync never substitutes the expected amount', () => {
    const view = {
      status: AppointmentStatus.PAYMENT_PENDING,
      amount: '1500.00',
      currency: 'LKR',
      payment: {
        status: PaymentStatus.PENDING,
        latestAttempt: { merchantReference: 'wp_ref' },
      },
    };
    const customer = { id: 'cust-1', role: UserRole.PUBLIC } as never;

    function syncService(verified: unknown) {
      const gw = { verifyByReference: jest.fn().mockResolvedValue(verified) };
      const svc = new PaymentsService(
        prisma as never,
        availability as never,
        occupancy as never,
        bookingGuard as never,
        gw as never,
        notifications as never,
      );
      jest.spyOn(svc, 'getForCustomer').mockResolvedValue(view as never);
      const finalize = jest
        .spyOn(svc, 'finalizeVerified')
        .mockResolvedValue({} as never);
      return { svc, finalize };
    }

    it.each([
      ['amount', { success: true, currency: 'LKR', pending: false }],
      ['currency', { success: true, amount: '1500.00', pending: false }],
    ])(
      'does not finalize a verified result missing %s',
      async (_n, verified) => {
        const { svc, finalize } = syncService(verified);
        await svc.syncForCustomer(customer, 'c-1');
        expect(finalize).not.toHaveBeenCalled();
      },
    );

    it('finalizes only with the gateway-provided amount and currency', async () => {
      const { svc, finalize } = syncService({
        success: true,
        amount: '1500.00',
        currency: 'LKR',
        providerPaymentId: 'pp-1',
      });
      await svc.syncForCustomer(customer, 'c-1');
      expect(finalize).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '1500.00', currency: 'LKR' }),
      );
    });
  });

  describe('mock callbacks', () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    const body = JSON.stringify({ merchantReference: 'wp_ref', success: true });

    it.each(['production', undefined, 'staging', 'Production', ''])(
      'are refused when NODE_ENV is %j (allowlist, fail closed)',
      async (env) => {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        await expect(service.handleMockNotify(body, {})).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(prisma.paymentAttempt.findUnique).not.toHaveBeenCalled();
      },
    );

    it('fills a missing amount/currency from the server-stored checkout, not the client', async () => {
      process.env.NODE_ENV = 'test';
      const gw = {
        verifyNotify: jest.fn().mockResolvedValue({
          merchantReference: 'wp_ref',
          providerPaymentId: 'mock_wp_ref',
          amount: '',
          currency: '',
          success: true,
        }),
      };
      const svc = new PaymentsService(
        prisma as never,
        availability as never,
        occupancy as never,
        bookingGuard as never,
        gw as never,
        notifications as never,
      );
      prisma.paymentAttempt.findUnique.mockImplementation(
        (args: { select?: unknown }) =>
          args.select
            ? { checkoutPayload: { amount: '1500.00', currency: 'LKR' } }
            : attempt,
      );
      const result = await svc.handleMockNotify(body, {});
      expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
    });

    it('a client-supplied wrong amount is kept and rejected, never replaced', async () => {
      process.env.NODE_ENV = 'test';
      const gw = {
        verifyNotify: jest.fn().mockResolvedValue({
          merchantReference: 'wp_ref',
          providerPaymentId: 'mock_wp_ref',
          amount: '1.00',
          currency: '',
          success: true,
        }),
      };
      const svc = new PaymentsService(
        prisma as never,
        availability as never,
        occupancy as never,
        bookingGuard as never,
        gw as never,
        notifications as never,
      );
      prisma.paymentAttempt.findUnique.mockImplementation(
        (args: { select?: unknown }) =>
          args.select
            ? { checkoutPayload: { amount: '1500.00', currency: 'LKR' } }
            : attempt,
      );
      await expect(svc.handleMockNotify(body, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('astrologer view never exposes payment details', () => {
    it('getSummaryForAstrologer does not load or return payments', async () => {
      prisma.appointment.findFirst.mockResolvedValue({
        ...appointment,
        status: AppointmentStatus.CONFIRMED,
      });
      const view = await service.getSummaryForAstrologer('c-1');
      expect(view?.payment).toBeNull();
      expect(JSON.stringify(view)).not.toContain('wp_ref');
      const query = prisma.appointment.findFirst.mock.calls[0][0] as {
        include?: unknown;
      };
      expect(query.include).toBeUndefined();
    });

    it('getSummaryForCustomer still returns the customer payment', async () => {
      prisma.appointment.findFirst.mockResolvedValue({
        ...appointment,
        status: AppointmentStatus.CONFIRMED,
        payments: [
          {
            id: 'pay-1',
            status: PaymentStatus.PAID,
            provider: 'MOCK',
            amount: '1500.00',
            currency: 'LKR',
            paidAt: new Date(),
            attempts: [
              {
                id: 'att-1',
                merchantReference: 'wp_ref',
                status: PaymentStatus.PAID,
                provider: 'MOCK',
                createdAt: new Date(),
              },
            ],
          },
        ],
      });
      const view = await service.getSummaryForCustomer('c-1');
      expect(view?.payment?.latestAttempt?.merchantReference).toBe('wp_ref');
    });
  });

  it('rejects amount mismatch without confirming', async () => {
    await expect(
      service.finalizeVerified({
        merchantReference: 'wp_ref',
        providerPaymentId: 'mock_wp_ref',
        amount: '1.00',
        currency: 'LKR',
        success: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('does not confirm after reservation expiry', async () => {
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      payment: {
        ...attempt.payment,
        appointment: {
          ...appointment,
          reservationExpiresAt: new Date(Date.now() - 1000),
        },
      },
    });
    const result = await service.finalizeVerified({
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500.00',
      currency: 'LKR',
      success: true,
    });
    expect(result).toMatchObject({ capturedAfterExpiry: true });
    expect(result.appointment?.status).not.toBe(AppointmentStatus.CONFIRMED);
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('asks for a refund after a late capture and still does not confirm', async () => {
    const refunds = {
      requestForAppointment: jest.fn().mockResolvedValue({ outcome: 'recorded' }),
    };
    const svc = new PaymentsService(
      prisma as never,
      availability as never,
      occupancy as never,
      bookingGuard as never,
      gateway as never,
      notifications as never,
      refunds as never,
    );
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      payment: {
        ...attempt.payment,
        appointment: {
          ...appointment,
          reservationExpiresAt: new Date(Date.now() - 1000),
        },
      },
    });
    const result = await svc.finalizeVerified({
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500.00',
      currency: 'LKR',
      success: true,
    });
    expect(result).toMatchObject({ capturedAfterExpiry: true });
    expect(result.appointment?.status).not.toBe(AppointmentStatus.CONFIRMED);
    expect(refunds.requestForAppointment).toHaveBeenCalledWith('apt-1');
    expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
  });

  it('flags a chargeback for review and does not start a refund', async () => {
    const localPrisma = {
      paymentAttempt: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'att-1' })
          .mockResolvedValueOnce({ payment: { appointmentId: 'apt-1' } }),
      },
      payHereNotification: { create: jest.fn().mockResolvedValue({ id: 'n-1' }) },
      appointment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const refunds = { requestForAppointment: jest.fn() };
    const payhere = {
      provider: 'PAYHERE',
      verifyNotification: () => ({
        outcome: 'chargedback',
        success: false,
        merchantReference: 'wp_ref',
        providerPaymentId: '320025014001',
        statusCode: -3,
        amount: '1500.00',
        currency: 'LKR',
        sanitized: { status_code: '-3' },
      }),
    };
    const svc = new PaymentsService(
      localPrisma as never,
      availability as never,
      occupancy as never,
      bookingGuard as never,
      payhere as never,
      notifications as never,
      refunds as never,
    );
    await expect(svc.handlePayHereNotify({})).resolves.toEqual({
      chargedback: true,
    });
    expect(localPrisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: 'apt-1' },
      data: { manualReviewRequired: true },
    });
    expect(refunds.requestForAppointment).not.toHaveBeenCalled();
  });

  it('duplicate callback on already-PAID is a no-op', async () => {
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      payment: {
        ...attempt.payment,
        status: PaymentStatus.PAID,
      },
    });
    const result = await service.finalizeVerified({
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500.00',
      currency: 'LKR',
      success: true,
    });
    expect(result.alreadyPaid).toBe(true);
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
  });

  describe('APPOINTMENT_CONFIRMED notifications', () => {
    const ref = {
      type: 'APPOINTMENT_CONFIRMED',
      consultationId: 'c-1',
      appointmentId: 'apt-1',
    };
    const notify = {
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '1500.00',
      currency: 'LKR',
      success: true,
    };

    it('creates exactly two notifications (customer and astrologer) in the lock transaction when the guarded transition changes one row', async () => {
      let doneAtDelivery: boolean | undefined;
      notifications.deliverAfterCommit.mockImplementation(() => {
        doneAtDelivery = lock.done;
      });

      await service.finalizeVerified(notify);

      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(tx, 'cust-1', ref);
      expect(notifications.notifyAstrologerProfile).toHaveBeenCalledTimes(1);
      expect(notifications.notifyAstrologerProfile).toHaveBeenCalledWith(
        tx,
        'ap-1',
        ref,
      );
      expect(notifications.deliverAfterCommit).toHaveBeenCalledTimes(1);
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith([
        'n-customer',
        'n-astrologer',
      ]);
      // Delivery starts only after the transaction/lock has completed.
      expect(doneAtDelivery).toBe(true);
    });

    it('does not notify when the guarded transition changed no row and the appointment is already CONFIRMED (lost race / repeated callback)', async () => {
      tx.appointment.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.finalizeVerified(notify);

      expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.notifyAstrologerProfile).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith([]);
    });

    it('repeated callbacks create one pair only: the second finds the appointment already confirmed', async () => {
      tx.appointment.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await service.finalizeVerified(notify);
      await service.finalizeVerified(notify);

      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyAstrologerProfile).toHaveBeenCalledTimes(1);
    });

    it('does not notify for an already-PAID payment', async () => {
      prisma.paymentAttempt.findUnique.mockResolvedValue({
        ...attempt,
        payment: { ...attempt.payment, status: PaymentStatus.PAID },
      });
      await service.finalizeVerified(notify);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.notifyAstrologerProfile).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('does not notify for a failed payment', async () => {
      const result = await service.finalizeVerified({
        ...notify,
        success: false,
      });
      expect(result.failed).toBe(true);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('does not notify on an amount mismatch', async () => {
      await expect(
        service.finalizeVerified({ ...notify, amount: '1.00' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('records a captured payment and refund obligation when the reservation expired before the lock', async () => {
      prisma.paymentAttempt.findUnique.mockResolvedValue({
        ...attempt,
        payment: {
          ...attempt.payment,
          appointment: {
            ...appointment,
            reservationExpiresAt: new Date(Date.now() - 1000),
          },
        },
      });
      const result = await service.finalizeVerified(notify);
      expect(result).toMatchObject({ capturedAfterExpiry: true });
      expect(result.appointment?.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);
      expect(bookingGuard.withAstrologerLock).not.toHaveBeenCalled();
      expect(failureTx.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.PAID }),
        }),
      );
      expect(failureTx.appointment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refundObligation: 'FULL_REFUND_DUE',
          }),
        }),
      );
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
      const settlement = evaluateSettlementEligibility({
        appointmentStatus: AppointmentStatus.COMPLETED,
        consultationStatus: ConsultationStatus.COMPLETED,
        completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        paymentStatus: PaymentStatus.PAID,
        paymentId: 'pay-1',
        appointmentAmount: '1500.00',
        paymentAmount: '1500.00',
        refundObligation: RefundObligation.FULL_REFUND_DUE,
        manualReviewRequired: false,
        now: new Date(),
      });
      expect(settlement.eligible).toBe(false);
      expect(settlement.reason).toBe('REFUND_OBLIGATION_BLOCKS_SETTLEMENT');
    });

    it('does not confirm when the reservation expires inside the lock', async () => {
      tx.appointment.updateMany.mockResolvedValue({ count: 0 });
      tx.appointment.findUniqueOrThrow.mockResolvedValue({
        ...appointment,
        status: AppointmentStatus.PAYMENT_EXPIRED,
        payments: [],
      });
      const result = await service.finalizeVerified(notify);
      expect(result).toMatchObject({ capturedAfterExpiry: true });
      expect(result.appointment?.status).not.toBe(AppointmentStatus.CONFIRMED);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.notifyAstrologerProfile).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('an unexpected notification failure propagates and nothing is delivered', async () => {
      notifications.notifyUser.mockRejectedValueOnce(new Error('deadlock'));
      await expect(service.finalizeVerified(notify)).rejects.toThrow(
        'deadlock',
      );
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('a tolerated-invalid notification (null id) does not break the confirmation', async () => {
      notifications.notifyUser.mockResolvedValueOnce(null);
      const result = await service.finalizeVerified(notify);
      expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith([
        null,
        'n-astrologer',
      ]);
    });
  });

  describe('checkout after the appointment lifecycle has advanced', () => {
    it.each([
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
      AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      AppointmentStatus.NO_SHOW_CUSTOMER,
      AppointmentStatus.NO_SHOW_ASTROLOGER,
      AppointmentStatus.NO_SHOW_BOTH,
    ])('never revives an appointment in %s', async (status) => {
      const consultationFind = jest.fn().mockResolvedValue({
        id: 'c-1',
        customerId: 'cust-1',
        astrologerId: 'ap-1',
        status: 'ACCEPTED',
        requestedPrice: '1500.00',
      });
      const proposalFind = jest
        .fn()
        .mockResolvedValue({ id: 'p-1', status: 'ACCEPTED' });
      (prisma as Record<string, unknown>).consultation = {
        findUnique: consultationFind,
      };
      (prisma as Record<string, unknown>).consultationProposal = {
        findFirst: proposalFind,
      };
      (tx.appointment as Record<string, unknown>).findUnique = jest
        .fn()
        .mockResolvedValue({ ...appointment, status, payments: [] });
      occupancy.expireDueReservations.mockResolvedValue(undefined);

      await expect(
        service.checkout(
          {
            id: 'cust-1',
            role: UserRole.PUBLIC,
            phone: '+94771234567',
            billingFirstName: 'Nimal',
            billingLastName: 'Perera',
            billingEmail: 'nimal@example.com',
            billingAddress: '12 Temple Road',
            billingCity: 'Colombo',
            billingCountry: 'Sri Lanka',
          } as never,
          'c-1',
          'p-1',
        ),
      ).rejects.toThrow(/Cannot checkout an appointment in status/);
    });
  });

  it('rejects non-PUBLIC checkout', async () => {
    await expect(
      service.checkout(
        { id: 'a1', role: UserRole.ASTROLOGER } as never,
        'c-1',
        'p-1',
      ),
    ).rejects.toThrow(/PUBLIC role required/);
  });

  describe('checkout billing profile', () => {
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
    const readyCustomer = {
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

    function prepareAcceptedCheckout() {
      (prisma as Record<string, unknown>).consultation = {
        findUnique: jest.fn().mockResolvedValue(consultation),
      };
      (prisma as Record<string, unknown>).consultationProposal = {
        findFirst: jest.fn().mockResolvedValue(proposal),
      };
    }

    it('rejects an incomplete billing profile before any reservation', async () => {
      prepareAcceptedCheckout();
      occupancy.expireDueReservations.mockClear();

      await expect(
        service.checkout(
          { id: 'cust-1', role: UserRole.PUBLIC, phone: '+94771234567' } as never,
          'c-1',
          'p-1',
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'BILLING_PROFILE_INCOMPLETE',
          missingFields: [
            'firstName',
            'lastName',
            'email',
            'address',
            'city',
            'country',
          ],
        },
      });

      expect(bookingGuard.withAstrologerLock).not.toHaveBeenCalled();
      expect(occupancy.expireDueReservations).not.toHaveBeenCalled();
    });

    it('continues the existing checkout flow when billing is complete', async () => {
      prepareAcceptedCheckout();
      const createdAppointment = {
        ...appointment,
        payments: [] as unknown[],
        sessionStartedAt: null,
        sessionEndedAt: null,
        actualDurationSeconds: null,
        cancelledAt: null,
        cancelReason: null,
        noShowRecordedAt: null,
        refundObligation: null,
        manualReviewRequired: false,
      };
      (tx.appointment as Record<string, unknown>).findUnique = jest
        .fn()
        .mockResolvedValue(null);
      (tx.appointment as Record<string, unknown>).create = jest
        .fn()
        .mockResolvedValue(createdAppointment);
      (tx.appointment as Record<string, unknown>).findUniqueOrThrow = jest
        .fn()
        .mockResolvedValue(createdAppointment);
      (tx.payment as unknown as { create: jest.Mock }).create = jest
        .fn()
        .mockResolvedValue({
          id: 'pay-1',
          status: PaymentStatus.PENDING,
          attempts: [],
        });
      (tx.paymentAttempt as unknown as { create: jest.Mock }).create = jest
        .fn()
        .mockResolvedValue({ id: 'att-1' });
      (
        occupancy as { loadOccupiedIntervals: jest.Mock }
      ).loadOccupiedIntervals = jest.fn().mockResolvedValue([]);
      (availability as { assertProposedSlotEligible?: jest.Mock }).assertProposedSlotEligible =
        jest.fn().mockResolvedValue(undefined);
      (gateway as { createCheckout?: jest.Mock }).createCheckout = jest
        .fn()
        .mockResolvedValue({ checkout: { mock: true } });
      (gateway as { chargePayment?: jest.Mock }).chargePayment = jest.fn();

      const result = await service.checkout(readyCustomer as never, 'c-1', 'p-1');

      expect(bookingGuard.withAstrologerLock).toHaveBeenCalled();
      expect(
        (tx.appointment as { create: jest.Mock }).create,
      ).toHaveBeenCalled();
      expect(
        (tx as { payment: { create: jest.Mock } }).payment.create,
      ).toHaveBeenCalled();
      expect(
        (tx as { paymentAttempt: { create: jest.Mock } }).paymentAttempt.create,
      ).toHaveBeenCalled();
      expect(result.checkout).toEqual({ mock: true });
      expect(
        (gateway as { chargePayment: jest.Mock }).chargePayment,
      ).not.toHaveBeenCalled();
      const attemptData = (
        tx.paymentAttempt as unknown as { create: jest.Mock }
      ).create.mock.calls[0][0].data;
      expect(attemptData.merchantReference).toMatch(/^wp_/);
      expect(JSON.stringify(attemptData)).not.toContain('customer_token');
    });

    it('does not start manual checkout over an open saved-card charge', async () => {
      prepareAcceptedCheckout();
      (tx.appointment as Record<string, unknown>).findUnique = jest
        .fn()
        .mockResolvedValue({
          ...appointment,
          status: AppointmentStatus.PAYMENT_PENDING,
          reservationExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          payments: [
            {
              attempts: [
                {
                  merchantReference: 'sc_open',
                  status: PaymentStatus.PENDING,
                  openChargeSlot: 'pay-1',
                  requiresReview: true,
                  createdAt: new Date(),
                  checkoutPayload: null,
                },
              ],
            },
          ],
        });
      (gateway as { createCheckout?: jest.Mock }).createCheckout = jest.fn();

      await expect(
        service.checkout(readyCustomer as never, 'c-1', 'p-1'),
      ).rejects.toThrow(/saved-card charge is already open/);
      expect(
        (gateway as { createCheckout: jest.Mock }).createCheckout,
      ).not.toHaveBeenCalled();
    });
  });
});

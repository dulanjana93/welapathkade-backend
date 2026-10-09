import { ConflictException } from '@nestjs/common';
import { AppointmentStatus, PaymentStatus, UserRole } from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService.finalizeVerified', () => {
  const prisma = {
    paymentAttempt: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { updateMany: jest.fn() },
    appointment: { findUniqueOrThrow: jest.fn() },
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

  it('confirms when gateway omits amount (Flutter mock callback)', async () => {
    const result = await service.finalizeVerified({
      merchantReference: 'wp_ref',
      providerPaymentId: 'mock_wp_ref',
      amount: '',
      currency: 'LKR',
      success: true,
    });
    expect(result.appointment?.status).toBe(AppointmentStatus.CONFIRMED);
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
    await expect(
      service.finalizeVerified({
        merchantReference: 'wp_ref',
        providerPaymentId: 'mock_wp_ref',
        amount: '1500.00',
        currency: 'LKR',
        success: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
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

    it('does not notify when the reservation expired before the lock', async () => {
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
      await expect(service.finalizeVerified(notify)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('does not notify when the reservation expired between the check and the lock', async () => {
      tx.appointment.updateMany.mockResolvedValue({ count: 0 });
      tx.appointment.findUniqueOrThrow.mockResolvedValue({
        ...appointment,
        status: AppointmentStatus.PAYMENT_EXPIRED,
        payments: [],
      });
      await expect(service.finalizeVerified(notify)).rejects.toBeInstanceOf(
        ConflictException,
      );
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

  it('rejects non-PUBLIC checkout', async () => {
    await expect(
      service.checkout(
        { id: 'a1', role: UserRole.ASTROLOGER } as never,
        'c-1',
        'p-1',
      ),
    ).rejects.toThrow(/PUBLIC role required/);
  });
});

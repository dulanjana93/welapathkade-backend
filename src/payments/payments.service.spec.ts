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

  const service = new PaymentsService(
    prisma as never,
    availability as never,
    occupancy as never,
    bookingGuard as never,
    gateway as never,
  );

  const appointment = {
    id: 'apt-1',
    consultationId: 'c-1',
    proposalId: 'p-1',
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
    bookingGuard.withAstrologerLock.mockImplementation(
      async (_id: string, work: (client: unknown) => unknown) => work(tx),
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

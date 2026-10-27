import { NotFoundException } from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { FinancialSnapshotService } from './financial-snapshot.service';
import { SETTLEMENT_HOLD_MS } from './settlement.constants';

const completedAt = new Date('2026-10-01T10:00:00.000Z');
const afterHold = new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS + 1000);

function eligibleAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apt-1',
    consultationId: 'c-1',
    astrologerId: 'ap-1',
    amount: new Prisma.Decimal('1000.00'),
    currency: 'LKR',
    status: AppointmentStatus.COMPLETED,
    refundObligation: null,
    manualReviewRequired: false,
    payments: [
      {
        id: 'pay-1',
        amount: new Prisma.Decimal('1000.00'),
        currency: 'LKR',
        status: PaymentStatus.PAID,
      },
    ],
    consultation: {
      id: 'c-1',
      status: ConsultationStatus.COMPLETED,
      completedAt,
      customer: { id: 'cust-1', referredByUserId: 'cust-ref' },
    },
    astrologer: {
      id: 'ap-1',
      user: { id: 'astro-user', referredByUserId: 'astro-ref' },
    },
    financialSnapshot: null,
    ...overrides,
  };
}

describe('FinancialSnapshotService', () => {
  const prisma = {
    appointment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    appointmentFinancialSnapshot: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  const service = new FinancialSnapshotService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a snapshot with both referral recipients frozen', async () => {
    prisma.appointment.findUnique.mockResolvedValue(eligibleAppointment());
    const created = {
      id: 'snap-1',
      appointmentId: 'apt-1',
      consultationId: 'c-1',
      paymentId: 'pay-1',
      currency: 'LKR',
      grossAmount: new Prisma.Decimal('1000.00'),
      basis: 'GROSS_CONSULTATION_AMOUNT',
      astrologerId: 'ap-1',
      astrologerPercent: new Prisma.Decimal('80.00'),
      astrologerAmount: new Prisma.Decimal('800.00'),
      customerReferrerUserId: 'cust-ref',
      customerReferralPercent: new Prisma.Decimal('3.00'),
      customerReferralAmount: new Prisma.Decimal('30.00'),
      astrologerReferrerUserId: 'astro-ref',
      astrologerReferralPercent: new Prisma.Decimal('3.00'),
      astrologerReferralAmount: new Prisma.Decimal('30.00'),
      platformPercent: new Prisma.Decimal('14.00'),
      platformAmount: new Prisma.Decimal('140.00'),
      status: 'RECORDED',
      completedAt,
      holdExpiresAt: new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS),
      createdAt: afterHold,
    };
    prisma.appointmentFinancialSnapshot.create.mockResolvedValue(created);

    const result = await service.ensureSnapshotForAppointment(
      'apt-1',
      afterHold,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.snapshot.grossAmount).toBe('1000.00');
    expect(result.snapshot.astrologerAmount).toBe('800.00');
    expect(result.snapshot.customerReferralAmount).toBe('30.00');
    expect(result.snapshot.astrologerReferralAmount).toBe('30.00');
    expect(result.snapshot.platformAmount).toBe('140.00');
    expect(result.snapshot.customerReferrerUserId).toBe('cust-ref');
    expect(result.snapshot.astrologerReferrerUserId).toBe('astro-ref');
    expect(result.snapshot.status).toBe('RECORDED');

    const createArgs = prisma.appointmentFinancialSnapshot.create.mock
      .calls[0] as [{ data: { customerReferrerUserId: string } }];
    expect(createArgs[0].data.customerReferrerUserId).toBe('cust-ref');
  });

  it('allocates platform residual when only customer referral exists', async () => {
    prisma.appointment.findUnique.mockResolvedValue(
      eligibleAppointment({
        consultation: {
          id: 'c-1',
          status: ConsultationStatus.COMPLETED,
          completedAt,
          customer: { id: 'cust-1', referredByUserId: 'cust-ref' },
        },
        astrologer: {
          id: 'ap-1',
          user: { id: 'astro-user', referredByUserId: null },
        },
      }),
    );
    prisma.appointmentFinancialSnapshot.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'snap-1',
          ...data,
          createdAt: afterHold,
        }),
    );

    const result = await service.ensureSnapshotForAppointment(
      'apt-1',
      afterHold,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.platformAmount).toBe('170.00');
    expect(result.snapshot.astrologerReferralAmount).toBe('0.00');
    expect(result.snapshot.astrologerReferrerUserId).toBeNull();
  });

  it('returns existing snapshot without recomputing (frozen recipients)', async () => {
    const existing = {
      id: 'snap-old',
      appointmentId: 'apt-1',
      consultationId: 'c-1',
      paymentId: 'pay-1',
      currency: 'LKR',
      grossAmount: new Prisma.Decimal('1000.00'),
      basis: 'GROSS_CONSULTATION_AMOUNT',
      astrologerId: 'ap-1',
      astrologerPercent: new Prisma.Decimal('80.00'),
      astrologerAmount: new Prisma.Decimal('800.00'),
      customerReferrerUserId: 'original-ref',
      customerReferralPercent: new Prisma.Decimal('3.00'),
      customerReferralAmount: new Prisma.Decimal('30.00'),
      astrologerReferrerUserId: null,
      astrologerReferralPercent: new Prisma.Decimal('0.00'),
      astrologerReferralAmount: new Prisma.Decimal('0.00'),
      platformPercent: new Prisma.Decimal('17.00'),
      platformAmount: new Prisma.Decimal('170.00'),
      status: 'RECORDED',
      completedAt,
      holdExpiresAt: new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS),
      createdAt: afterHold,
    };
    prisma.appointment.findUnique.mockResolvedValue(
      eligibleAppointment({
        financialSnapshot: existing,
        consultation: {
          id: 'c-1',
          status: ConsultationStatus.COMPLETED,
          completedAt,
          // Attribution changed after snapshot — must not affect return.
          customer: { id: 'cust-1', referredByUserId: 'new-ref' },
        },
      }),
    );

    const result = await service.ensureSnapshotForAppointment(
      'apt-1',
      afterHold,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.snapshot.customerReferrerUserId).toBe('original-ref');
    expect(prisma.appointmentFinancialSnapshot.create).not.toHaveBeenCalled();
  });

  it('blocks unpaid and hold-active appointments', async () => {
    prisma.appointment.findUnique.mockResolvedValue(
      eligibleAppointment({
        payments: [
          {
            id: 'pay-1',
            amount: new Prisma.Decimal('1000.00'),
            currency: 'LKR',
            status: PaymentStatus.PENDING,
          },
        ],
      }),
    );
    let result = await service.ensureSnapshotForAppointment('apt-1', afterHold);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PAYMENT_NOT_PAID');

    prisma.appointment.findUnique.mockResolvedValue(eligibleAppointment());
    result = await service.ensureSnapshotForAppointment(
      'apt-1',
      new Date(completedAt.getTime() + 60_000),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('SETTLEMENT_HOLD_ACTIVE');
    expect(prisma.appointmentFinancialSnapshot.create).not.toHaveBeenCalled();
  });

  it('blocks refund obligation and manual review', async () => {
    prisma.appointment.findUnique.mockResolvedValue(
      eligibleAppointment({ refundObligation: 'FULL_REFUND_DUE' }),
    );
    let result = await service.ensureSnapshotForAppointment('apt-1', afterHold);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('REFUND_OBLIGATION_BLOCKS_SETTLEMENT');

    prisma.appointment.findUnique.mockResolvedValue(
      eligibleAppointment({ manualReviewRequired: true }),
    );
    result = await service.ensureSnapshotForAppointment('apt-1', afterHold);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('handles concurrent create via unique constraint (P2002)', async () => {
    prisma.appointment.findUnique.mockResolvedValue(eligibleAppointment());
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.appointmentFinancialSnapshot.create.mockRejectedValue(conflict);
    const existing = {
      id: 'snap-race',
      appointmentId: 'apt-1',
      consultationId: 'c-1',
      paymentId: 'pay-1',
      currency: 'LKR',
      grossAmount: new Prisma.Decimal('1000.00'),
      basis: 'GROSS_CONSULTATION_AMOUNT',
      astrologerId: 'ap-1',
      astrologerPercent: new Prisma.Decimal('80.00'),
      astrologerAmount: new Prisma.Decimal('800.00'),
      customerReferrerUserId: 'cust-ref',
      customerReferralPercent: new Prisma.Decimal('3.00'),
      customerReferralAmount: new Prisma.Decimal('30.00'),
      astrologerReferrerUserId: 'astro-ref',
      astrologerReferralPercent: new Prisma.Decimal('3.00'),
      astrologerReferralAmount: new Prisma.Decimal('30.00'),
      platformPercent: new Prisma.Decimal('14.00'),
      platformAmount: new Prisma.Decimal('140.00'),
      status: 'RECORDED',
      completedAt,
      holdExpiresAt: new Date(completedAt.getTime() + SETTLEMENT_HOLD_MS),
      createdAt: afterHold,
    };
    prisma.appointmentFinancialSnapshot.findUnique.mockResolvedValue(existing);

    const result = await service.ensureSnapshotForAppointment(
      'apt-1',
      afterHold,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.snapshot.id).toBe('snap-race');
  });

  it('throws when appointment is missing', async () => {
    prisma.appointment.findUnique.mockResolvedValue(null);
    await expect(
      service.ensureSnapshotForAppointment('missing', afterHold),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createDueSnapshots only targets hold-elapsed candidates', async () => {
    prisma.appointment.findMany.mockResolvedValue([{ id: 'apt-1' }]);
    prisma.appointment.findUnique.mockResolvedValue(eligibleAppointment());
    prisma.appointmentFinancialSnapshot.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'snap-1',
          ...data,
          createdAt: afterHold,
        }),
    );

    const result = await service.createDueSnapshots(afterHold);
    expect(result.created).toBe(1);
    expect(prisma.appointment.findMany).toHaveBeenCalled();
    const findArgs = prisma.appointment.findMany.mock.calls[0] as [
      {
        where: { consultation: { completedAt: { lte: Date } } };
      },
    ];
    expect(findArgs[0].where.consultation.completedAt.lte.getTime()).toBe(
      afterHold.getTime() - SETTLEMENT_HOLD_MS,
    );
  });
});

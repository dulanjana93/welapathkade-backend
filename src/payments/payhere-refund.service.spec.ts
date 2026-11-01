import { ConflictException } from '@nestjs/common';
import {
  AppointmentStatus,
  PaymentProvider,
  PaymentStatus,
  PayHereRefundReason,
  PayHereRefundStatus,
  Prisma,
  RefundObligation,
  type PayHereRefund,
} from '@prisma/client';
import {
  ASTROLOGER_SHARE,
  REFERRAL_SHARE,
  SETTLEMENT_HOLD_MS,
} from '../settlement/settlement.constants';
import { evaluateSettlementEligibility } from '../settlement/settlement-eligibility';
import { PayHereRefundService } from './payhere-refund.service';
import {
  PayHereRateLimitError,
  type PayHereRefundCall,
  type RetrievedRefundState,
} from './payhere/payhere.gateway';

describe('PayHereRefundService', () => {
  const refunds: PayHereRefund[] = [];
  const notifications: Array<{
    id: string;
    merchantReference: string;
    payherePaymentId: string;
    statusCode: number;
    amount: Prisma.Decimal | null;
    currency: string | null;
    createdAt: Date;
  }> = [];
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  let seq = 0;

  const appointment = {
    id: 'apt-1',
    status: AppointmentStatus.PAYMENT_EXPIRED,
    refundObligation: RefundObligation.FULL_REFUND_DUE as RefundObligation | null,
    manualReviewRequired: false,
    payments: [
      {
        id: 'pay-1',
        status: PaymentStatus.PAID,
        provider: PaymentProvider.PAYHERE,
        amount: '1500.00',
        currency: 'LKR',
        attempts: [
          {
            id: 'att-1',
            paymentId: 'pay-1',
            merchantReference: 'wp_apt_1',
            providerPaymentId: '320025014001' as string | null,
          },
        ],
      },
    ],
  };

  const payhere = {
    hasMerchantCapacity: jest.fn(() => true),
    refundPayment: jest.fn<Promise<PayHereRefundCall>, [string, string]>(),
    retrieveForRefund: jest.fn<
      Promise<RetrievedRefundState>,
      [string, string]
    >(),
  };
  const ledger = {
    reversePostedSnapshotForRefundObligation: jest
      .fn()
      .mockResolvedValue({ ok: true, reversed: false }),
  };

  function attempts() {
    return appointment.payments.flatMap((payment) =>
      payment.attempts.map((attempt) => ({
        ...attempt,
        paymentId: payment.id,
      })),
    );
  }

  function matchRefund(
    row: PayHereRefund,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (!where) return true;
    if (where.OR) {
      return (where.OR as Record<string, unknown>[]).some((part) =>
        matchRefund(row, part),
      );
    }
    if (where.id && row.id !== where.id) return false;
    if (where.paymentId && row.paymentId !== where.paymentId) return false;
    if (
      where.openRefundSlot &&
      row.openRefundSlot !== where.openRefundSlot
    ) {
      return false;
    }
    if (where.retrySafe !== undefined && row.retrySafe !== where.retrySafe) {
      return false;
    }
    if (where.status) {
      const status = where.status as { in?: PayHereRefundStatus[] } | string;
      if (typeof status === 'string' && row.status !== status) return false;
      if (
        typeof status === 'object' &&
        status.in &&
        !status.in.includes(row.status)
      ) {
        return false;
      }
    }
    return true;
  }

  const prisma = {
    appointment: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === appointment.id ? appointment : null,
      ),
      findMany: jest.fn(async () => {
        const hasRefund = refunds.some((row) => row.paymentId === 'pay-1');
        if (
          appointment.refundObligation === RefundObligation.FULL_REFUND_DUE &&
          appointment.payments.some(
            (payment) =>
              payment.status === PaymentStatus.PAID &&
              payment.provider === PaymentProvider.PAYHERE,
          ) &&
          !hasRefund
        ) {
          return [{ id: appointment.id }];
        }
        return [];
      }),
      updateMany: jest.fn(
        async ({ data }: { data: { manualReviewRequired?: boolean } }) => {
          Object.assign(appointment, data);
          return { count: 1 };
        },
      ),
    },
    paymentAttempt: {
      findMany: jest.fn(async ({ where }: { where?: { paymentId?: string } }) =>
        attempts().filter(
          (attempt) => !where?.paymentId || attempt.paymentId === where.paymentId,
        ),
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { paymentId: string; providerPaymentId: string };
        }) =>
          attempts().find(
            (attempt) =>
              attempt.paymentId === where.paymentId &&
              attempt.providerPaymentId === where.providerPaymentId,
          ) ?? null,
      ),
    },
    payHereNotification: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { statusCode: number; merchantReference: { in: string[] } };
        }) =>
          notifications.find(
            (row) =>
              row.statusCode === where.statusCode &&
              where.merchantReference.in.includes(row.merchantReference),
          ) ?? null,
      ),
      count: jest.fn(
        async ({ where }: { where: { statusCode: number } }) =>
          notifications.filter((row) => row.statusCode === where.statusCode)
            .length,
      ),
      findMany: jest.fn(async ({ where }: { where: { statusCode: number } }) =>
        notifications.filter((row) => row.statusCode === where.statusCode),
      ),
    },
    payHereRefund: {
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          skip,
          take,
        }: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'>;
          skip?: number;
          take?: number;
        }) => {
          let rows = refunds.filter((row) => matchRefund(row, where));
          const [field, direction] = Object.entries(
            orderBy ?? { createdAt: 'desc' },
          )[0] as [keyof PayHereRefund, 'asc' | 'desc'];
          rows = [...rows].sort((left, right) => {
            const delta =
              new Date(left[field] as Date).getTime() -
              new Date(right[field] as Date).getTime();
            return direction === 'desc' ? -delta : delta;
          });
          if (skip) rows = rows.slice(skip);
          if (take) rows = rows.slice(0, take);
          return rows;
        },
      ),
      findFirst: jest.fn(async (args: { where?: Record<string, unknown> }) => {
        const rows = await prisma.payHereRefund.findMany({
          where: args.where,
          orderBy: { createdAt: 'desc' },
        });
        return rows[0] ?? null;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        refunds.find((row) => row.id === where.id) ?? null,
      ),
      count: jest.fn(
        async ({ where }: { where?: Record<string, unknown> }) =>
          refunds.filter((row) => matchRefund(row, where)).length,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (
          data.openRefundSlot &&
          refunds.some((row) => row.openRefundSlot === data.openRefundSlot)
        ) {
          throw new Prisma.PrismaClientKnownRequestError('Unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        clock += 1000;
        const created = {
          id: `rf-${++seq}`,
          payhereRefundNumber: null,
          retrySafe: false,
          failureMessage: null,
          providerStatus: null,
          sanitizedResponse: null,
          initiatedAt: new Date(clock),
          lastReconciledAt: null,
          completedAt: null,
          createdAt: new Date(clock),
          updatedAt: new Date(clock),
          ...data,
        } as PayHereRefund;
        refunds.push(created);
        return created;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = refunds.find((item) => item.id === where.id);
          if (!row) throw new Error('missing refund');
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
      ),
      deleteMany: jest.fn(
        async ({
          where,
        }: {
          where: { id: string; status: PayHereRefundStatus };
        }) => {
          const before = refunds.length;
          for (let index = refunds.length - 1; index >= 0; index -= 1) {
            if (
              refunds[index].id === where.id &&
              refunds[index].status === where.status
            ) {
              refunds.splice(index, 1);
            }
          }
          return { count: before - refunds.length };
        },
      ),
    },
  };

  const service = new PayHereRefundService(
    prisma as never,
    payhere,
    ledger as never,
  );

  function paidResponse(kind: PayHereRefundCall) {
    payhere.refundPayment.mockResolvedValue(kind);
  }

  beforeEach(() => {
    refunds.splice(0, refunds.length);
    notifications.splice(0, notifications.length);
    seq = 0;
    appointment.status = AppointmentStatus.PAYMENT_EXPIRED;
    appointment.refundObligation = RefundObligation.FULL_REFUND_DUE;
    appointment.manualReviewRequired = false;
    appointment.payments[0].status = PaymentStatus.PAID;
    appointment.payments[0].provider = PaymentProvider.PAYHERE;
    appointment.payments[0].attempts[0].providerPaymentId = '320025014001';
    jest.clearAllMocks();
    payhere.hasMerchantCapacity.mockReturnValue(true);
    ledger.reversePostedSnapshotForRefundObligation.mockResolvedValue({
      ok: true,
      reversed: false,
    });
  });

  it('starts a full refund for a captured payment with FULL_REFUND_DUE', async () => {
    paidResponse({
      kind: 'started',
      refundNumber: '560034010257',
      providerStatus: 1,
      message: 'Refund is completely successfully',
    });
    const result = await service.requestForAppointment('apt-1');
    expect(result).toMatchObject({
      outcome: 'recorded',
      status: PayHereRefundStatus.SUCCEEDED,
    });
    expect(payhere.refundPayment).toHaveBeenCalledWith(
      '320025014001',
      'Welapathkade consultation refund',
    );
    expect(refunds[0]).toMatchObject({
      amount: expect.anything(),
      currency: 'LKR',
      reason: PayHereRefundReason.RESERVATION_EXPIRED,
      payhereRefundNumber: '560034010257',
      status: PayHereRefundStatus.SUCCEEDED,
    });
    expect(new Prisma.Decimal(refunds[0].amount).toFixed(2)).toBe('1500.00');
    expect(ledger.reversePostedSnapshotForRefundObligation).toHaveBeenCalledTimes(
      1,
    );
    expect(ledger.reversePostedSnapshotForRefundObligation).toHaveBeenCalledWith(
      'apt-1',
    );
  });

  it('does not refund an unpaid or failed payment', async () => {
    appointment.payments[0].status = PaymentStatus.PENDING;
    await expect(service.requestForAppointment('apt-1')).resolves.toMatchObject({
      reason: 'unpaid',
    });
    appointment.payments[0].status = PaymentStatus.FAILED;
    await expect(service.requestForAppointment('apt-1')).resolves.toMatchObject({
      reason: 'failed',
    });
    expect(payhere.refundPayment).not.toHaveBeenCalled();
    expect(refunds).toHaveLength(0);
    expect(ledger.reversePostedSnapshotForRefundObligation).not.toHaveBeenCalled();
  });

  it('blocks a refund when the PayHere payment id is missing', async () => {
    appointment.payments[0].attempts[0].providerPaymentId = null;
    await expect(service.requestForAppointment('apt-1')).resolves.toMatchObject({
      reason: 'missing-payment-id',
    });
    expect(payhere.refundPayment).not.toHaveBeenCalled();
  });

  it('does not send a second refund after success or a duplicate event', async () => {
    paidResponse({
      kind: 'started',
      refundNumber: '560034010257',
      providerStatus: 1,
      message: 'ok',
    });
    await service.requestForAppointment('apt-1');
    await service.requestForAppointment('apt-1');
    expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
    expect(ledger.reversePostedSnapshotForRefundObligation).toHaveBeenCalledTimes(
      1,
    );
    expect(refunds).toHaveLength(1);
  });

  it('does not retry immediately when the refund request times out', async () => {
    paidResponse({
      kind: 'uncertain',
      providerStatus: 0,
      message: 'PayHere refund request did not complete',
    });
    const first = await service.requestForAppointment('apt-1');
    const second = await service.requestForAppointment('apt-1');
    expect(first).toMatchObject({ status: PayHereRefundStatus.REQUIRES_REVIEW });
    expect(second).toMatchObject({ reason: 'in-progress' });
    expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
    expect(refunds[0].retrySafe).toBe(false);
    expect(ledger.reversePostedSnapshotForRefundObligation).not.toHaveBeenCalled();
  });

  it('keeps REFUND REQUESTED and REFUND PROCESSING from starting another refund', async () => {
    paidResponse({
      kind: 'uncertain',
      providerStatus: 0,
      message: 'uncertain',
    });
    const started = await service.requestForAppointment('apt-1');
    for (const providerStatus of ['REFUND REQUESTED', 'REFUND PROCESSING']) {
      payhere.retrieveForRefund.mockResolvedValue({
        kind: 'matched',
        providerStatus,
      });
      await service.reconcileOne(
        started.outcome === 'recorded' ? started.refundId : '',
      );
      await service.requestForAppointment('apt-1');
      expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
      expect(refunds[0].status).toBe(PayHereRefundStatus.PROCESSING);
    }
  });

  it('marks the refund successful when retrieval says REFUNDED and reverses once', async () => {
    paidResponse({
      kind: 'uncertain',
      providerStatus: 0,
      message: 'uncertain',
    });
    const started = await service.requestForAppointment('apt-1');
    payhere.retrieveForRefund.mockResolvedValue({
      kind: 'matched',
      providerStatus: 'REFUNDED',
    });
    const refundId = started.outcome === 'recorded' ? started.refundId : '';
    await service.reconcileOne(refundId);
    await service.reconcileOne(refundId);
    expect(refunds[0].status).toBe(PayHereRefundStatus.SUCCEEDED);
    expect(refunds[0].completedAt).toBeInstanceOf(Date);
    expect(ledger.reversePostedSnapshotForRefundObligation).toHaveBeenCalledTimes(
      1,
    );
  });

  it('ignores retrieval of a different payment id and leaves an ambiguous result unresolved', async () => {
    paidResponse({
      kind: 'uncertain',
      providerStatus: 0,
      message: 'uncertain',
    });
    const started = await service.requestForAppointment('apt-1');
    const refundId = started.outcome === 'recorded' ? started.refundId : '';
    payhere.retrieveForRefund.mockResolvedValue({ kind: 'not-this-payment' });
    await service.reconcileOne(refundId);
    expect(refunds[0].status).toBe(PayHereRefundStatus.REQUIRES_REVIEW);
    payhere.retrieveForRefund.mockResolvedValue({ kind: 'ambiguous' });
    await service.reconcileOne(refundId);
    expect(refunds[0].status).toBe(PayHereRefundStatus.REQUIRES_REVIEW);
    expect(refunds[0].lastReconciledAt).toBeInstanceOf(Date);
    expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
  });

  it('records a definitive PayHere failure without retrying until retrieval says it never started', async () => {
    paidResponse({
      kind: 'failed',
      providerStatus: -1,
      message: 'Refund failed',
    });
    const started = await service.requestForAppointment('apt-1');
    const refundId = started.outcome === 'recorded' ? started.refundId : '';
    await expect(service.retry(refundId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
    payhere.retrieveForRefund.mockResolvedValue({
      kind: 'matched',
      providerStatus: 'RECEIVED',
    });
    await service.reconcileOne(refundId);
    expect(refunds[0]).toMatchObject({
      status: PayHereRefundStatus.FAILED,
      retrySafe: true,
      openRefundSlot: null,
    });
    paidResponse({
      kind: 'started',
      refundNumber: '560034010258',
      providerStatus: 1,
      message: 'ok',
    });
    await service.retry(refundId);
    expect(payhere.refundPayment).toHaveBeenCalledTimes(2);
    expect(refunds).toHaveLength(2);
    expect(refunds[0].id).toBe(refundId);
  });

  it('does not credit a wallet when a refund is only initiated', async () => {
    paidResponse({
      kind: 'uncertain',
      providerStatus: 0,
      message: 'uncertain',
    });
    await service.requestForAppointment('apt-1');
    expect(ledger.reversePostedSnapshotForRefundObligation).not.toHaveBeenCalled();
    expect(ASTROLOGER_SHARE.toFixed(2)).toBe('0.80');
    expect(REFERRAL_SHARE.toFixed(2)).toBe('0.03');
    expect(SETTLEMENT_HOLD_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('keeps settlement blocked while the refund obligation remains', () => {
    const decision = evaluateSettlementEligibility({
      appointmentStatus: AppointmentStatus.COMPLETED,
      consultationStatus: 'COMPLETED' as never,
      completedAt: new Date('2026-10-01T00:00:00.000Z'),
      paymentStatus: PaymentStatus.PAID,
      paymentId: 'pay-1',
      appointmentAmount: '1500.00',
      paymentAmount: '1500.00',
      refundObligation: RefundObligation.FULL_REFUND_DUE,
      manualReviewRequired: false,
      now: new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('REFUND_OBLIGATION_BLOCKS_SETTLEMENT');
  });

  it('does not refund a chargebacked payment', async () => {
    notifications.push({
      id: 'note-1',
      merchantReference: 'wp_apt_1',
      payherePaymentId: '320025014001',
      statusCode: -3,
      amount: new Prisma.Decimal('1500.00'),
      currency: 'LKR',
      createdAt: new Date(),
    });
    await expect(service.requestForAppointment('apt-1')).resolves.toMatchObject({
      reason: 'chargeback',
    });
    expect(appointment.manualReviewRequired).toBe(true);
    expect(payhere.refundPayment).not.toHaveBeenCalled();
    payhere.retrieveForRefund.mockResolvedValue({
      kind: 'matched',
      providerStatus: 'CHARGEBACKED',
    });
  });

  it('starts the expired-reservation refund from the sweep once, and a second pass does not', async () => {
    paidResponse({
      kind: 'started',
      refundNumber: '560034010257',
      providerStatus: 1,
      message: 'ok',
    });
    expect(await service.initiateDue()).toEqual({ started: 1 });
    expect(await service.initiateDue()).toEqual({ started: 0 });
    expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
    expect(appointment.status).toBe(AppointmentStatus.PAYMENT_EXPIRED);
  });

  it('drops an unsent rate-limited claim so a later pass can try', async () => {
    payhere.refundPayment.mockRejectedValue(new PayHereRateLimitError());
    await expect(service.requestForAppointment('apt-1')).resolves.toMatchObject({
      reason: 'not-sent',
    });
    expect(refunds).toHaveLength(0);
    paidResponse({
      kind: 'started',
      refundNumber: '560034010257',
      providerStatus: 1,
      message: 'ok',
    });
    await service.requestForAppointment('apt-1');
    expect(payhere.refundPayment).toHaveBeenCalledTimes(2);
  });

  it('lists refunds and rejects an admin retry while the outcome is uncertain', async () => {
    paidResponse({
      kind: 'uncertain',
      providerStatus: 0,
      message: 'uncertain',
    });
    const started = await service.requestForAppointment('apt-1');
    const refundId = started.outcome === 'recorded' ? started.refundId : '';
    const page = await service.list({
      status: PayHereRefundStatus.REQUIRES_REVIEW,
      page: 1,
      pageSize: 20,
    });
    expect(page.total).toBe(1);
    expect(page.items[0].retryAllowed).toBe(false);
    expect(JSON.stringify(page)).not.toContain('merchant-secret');
    const detail = await service.get(refundId);
    expect(detail.history).toHaveLength(1);
    expect(detail.chargeback).toBe(false);
    await expect(service.retry(refundId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    payhere.retrieveForRefund.mockResolvedValue({ kind: 'unavailable' });
    expect(await service.reconcileUnresolved()).toEqual({ checked: 1 });
    expect(payhere.refundPayment).toHaveBeenCalledTimes(1);
  });
});

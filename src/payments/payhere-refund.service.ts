import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { toMoneyString } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import { FinancialLedgerService } from '../settlement/financial-ledger.service';
import {
  PayHereRateLimitError,
  PayHereRefundNotSentError,
  type PayHereGateway,
  type PayHereRefundCall,
  type RetrievedRefundState,
} from './payhere/payhere.gateway';

export const PAYHERE_MERCHANT = 'PAYHERE_MERCHANT';

const REFUND_DESCRIPTION = 'Welapathkade consultation refund';
const DUE_BATCH = 5;

type MerchantClient = Pick<
  PayHereGateway,
  'hasMerchantCapacity' | 'refundPayment' | 'retrieveForRefund'
>;

export type RefundView = {
  id: string;
  paymentId: string;
  appointmentId: string;
  payherePaymentId: string;
  payhereRefundNumber: string | null;
  amount: string;
  currency: string;
  status: PayHereRefundStatus;
  reason: PayHereRefundReason;
  retryAllowed: boolean;
  failureMessage: string | null;
  providerStatus: number | null;
  sanitizedResponse: Prisma.JsonValue | null;
  initiatedAt: Date;
  lastReconciledAt: Date | null;
  completedAt: Date | null;
};

export type RefundRequestResult =
  | { outcome: 'skipped'; reason: string; refundId?: string }
  | { outcome: 'recorded'; refundId: string; status: PayHereRefundStatus };

/**
 * Starts and reconciles PayHere refunds for an existing FULL_REFUND_DUE
 * obligation. The obligation, the PayHere request, and a ledger reversal are
 * separate facts. This service does not confirm an appointment or credit a wallet.
 */
@Injectable()
export class PayHereRefundService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYHERE_MERCHANT)
    private readonly payhere: MerchantClient | null,
    private readonly ledger: FinancialLedgerService,
  ) {}

  async requestForAppointment(
    appointmentId: string,
    options?: { adminRetry?: boolean },
  ): Promise<RefundRequestResult> {
    const eligible = await this.loadEligible(appointmentId);
    if (!('paymentId' in eligible)) {
      return { outcome: 'skipped', reason: eligible.reason };
    }
    if (!this.payhere) {
      return { outcome: 'skipped', reason: 'payhere-disabled' };
    }

    const existing = await this.prisma.payHereRefund.findMany({
      where: { paymentId: eligible.paymentId },
      orderBy: { createdAt: 'desc' },
    });
    const open = existing.find((row) => row.openRefundSlot);
    if (open) {
      return { outcome: 'skipped', reason: 'in-progress', refundId: open.id };
    }
    if (options?.adminRetry) {
      const latest = existing[0];
      if (
        !latest ||
        latest.status !== PayHereRefundStatus.FAILED ||
        !latest.retrySafe ||
        latest.openRefundSlot
      ) {
        throw new ConflictException(
          'Refund cannot be retried until retrieval shows the previous request never started',
        );
      }
    } else if (existing.length > 0) {
      return {
        outcome: 'skipped',
        reason: 'awaiting-review',
        refundId: existing[0].id,
      };
    }

    if (!this.payhere.hasMerchantCapacity()) {
      return { outcome: 'skipped', reason: 'rate-limited' };
    }

    let created: PayHereRefund;
    try {
      created = await this.prisma.payHereRefund.create({
        data: {
          paymentId: eligible.paymentId,
          appointmentId: eligible.appointmentId,
          payherePaymentId: eligible.payherePaymentId,
          amount: eligible.amount,
          currency: eligible.currency,
          status: PayHereRefundStatus.PROCESSING,
          reason: options?.adminRetry
            ? PayHereRefundReason.ADMIN_RETRY
            : eligible.reason,
          openRefundSlot: eligible.paymentId,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const current = await this.prisma.payHereRefund.findFirst({
        where: { openRefundSlot: eligible.paymentId },
      });
      return {
        outcome: 'skipped',
        reason: 'in-progress',
        refundId: current?.id,
      };
    }

    return this.send(created, eligible.payherePaymentId);
  }

  async retry(refundId: string): Promise<RefundRequestResult> {
    const row = await this.prisma.payHereRefund.findUnique({
      where: { id: refundId },
    });
    if (!row) throw new NotFoundException('Refund not found');
    if (!this.isRetryAllowed(row)) {
      throw new ConflictException(
        'Refund cannot be retried until retrieval shows the previous request never started',
      );
    }
    return this.requestForAppointment(row.appointmentId, { adminRetry: true });
  }

  async list(query: {
    status?: PayHereRefundStatus;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where = query.status ? { status: query.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.payHereRefund.count({ where }),
      this.prisma.payHereRefund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: rows.map(toView) };
  }

  async get(id: string) {
    const row = await this.prisma.payHereRefund.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Refund not found');
    const history = await this.prisma.payHereRefund.findMany({
      where: { paymentId: row.paymentId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...toView(row),
      chargeback: await this.hasChargeback(row.paymentId),
      history: history.map(toView),
    };
  }

  async listChargebacks(page = 1, pageSize = 20) {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const where = { statusCode: -3 };
    const [total, rows] = await Promise.all([
      this.prisma.payHereNotification.count({ where }),
      this.prisma.payHereNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeSize,
        take: safeSize,
        select: {
          id: true,
          merchantReference: true,
          payherePaymentId: true,
          statusCode: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      page: safePage,
      pageSize: safeSize,
      total,
      items: rows.map((row) => ({
        id: row.id,
        merchantReference: row.merchantReference,
        payherePaymentId: row.payherePaymentId,
        statusCode: row.statusCode,
        status: 'CHARGEBACKED' as const,
        amount: row.amount ? toMoneyString(row.amount) : null,
        currency: row.currency,
        createdAt: row.createdAt,
      })),
    };
  }

  async reconcileOne(id: string) {
    const row = await this.prisma.payHereRefund.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Refund not found');
    if (row.status === PayHereRefundStatus.SUCCEEDED) return this.get(id);
    await this.reconcileRow(row);
    return this.get(id);
  }

  async reconcileUnresolved(): Promise<{ checked: number }> {
    const rows = await this.prisma.payHereRefund.findMany({
      where: {
        OR: [
          {
            status: {
              in: [
                PayHereRefundStatus.PENDING,
                PayHereRefundStatus.PROCESSING,
                PayHereRefundStatus.REQUIRES_REVIEW,
              ],
            },
          },
          { status: PayHereRefundStatus.FAILED, retrySafe: false },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: DUE_BATCH,
    });
    let checked = 0;
    for (const row of rows) {
      if (this.payhere && !this.payhere.hasMerchantCapacity()) break;
      await this.reconcileRow(row);
      checked += 1;
    }
    return { checked };
  }

  /** First attempt only. A failed or uncertain row waits for admin retry. */
  async initiateDue(): Promise<{ started: number }> {
    const due = await this.prisma.appointment.findMany({
      where: {
        refundObligation: RefundObligation.FULL_REFUND_DUE,
        payments: {
          some: {
            status: PaymentStatus.PAID,
            provider: PaymentProvider.PAYHERE,
            payHereRefunds: { none: {} },
          },
        },
      },
      select: { id: true },
      take: DUE_BATCH,
    });
    let started = 0;
    for (const appointment of due) {
      const result = await this.requestForAppointment(appointment.id);
      if (
        result.outcome === 'skipped' &&
        (result.reason === 'rate-limited' || result.reason === 'not-sent')
      ) {
        break;
      }
      if (result.outcome === 'recorded') started += 1;
    }
    return { started };
  }

  private async send(
    created: PayHereRefund,
    payherePaymentId: string,
  ): Promise<RefundRequestResult> {
    if (!this.payhere) {
      await this.releaseUnsent(created.id);
      return { outcome: 'skipped', reason: 'payhere-disabled' };
    }
    let call: PayHereRefundCall;
    try {
      call = await this.payhere.refundPayment(
        payherePaymentId,
        REFUND_DESCRIPTION,
      );
    } catch (error) {
      if (
        error instanceof PayHereRateLimitError ||
        error instanceof PayHereRefundNotSentError
      ) {
        await this.releaseUnsent(created.id);
        return { outcome: 'skipped', reason: 'not-sent' };
      }
      await this.markUncertain(created.id, 0, 'PayHere refund request did not complete');
      return {
        outcome: 'recorded',
        refundId: created.id,
        status: PayHereRefundStatus.REQUIRES_REVIEW,
      };
    }

    if (call.kind === 'started') {
      await this.prisma.payHereRefund.update({
        where: { id: created.id },
        data: {
          status: PayHereRefundStatus.SUCCEEDED,
          payhereRefundNumber: call.refundNumber,
          providerStatus: call.providerStatus,
          failureMessage: null,
          retrySafe: false,
          completedAt: new Date(),
          sanitizedResponse: {
            status: call.providerStatus,
            msg: call.message,
            data: call.refundNumber,
          },
        },
      });
      await this.reverseIfPosted(created.appointmentId);
      return {
        outcome: 'recorded',
        refundId: created.id,
        status: PayHereRefundStatus.SUCCEEDED,
      };
    }

    if (call.kind === 'failed') {
      await this.prisma.payHereRefund.update({
        where: { id: created.id },
        data: {
          status: PayHereRefundStatus.FAILED,
          providerStatus: call.providerStatus,
          failureMessage: call.message || 'PayHere refused the refund',
          retrySafe: false,
          sanitizedResponse: {
            status: call.providerStatus,
            msg: call.message,
          },
        },
      });
      return {
        outcome: 'recorded',
        refundId: created.id,
        status: PayHereRefundStatus.FAILED,
      };
    }

    await this.markUncertain(created.id, call.providerStatus, call.message);
    return {
      outcome: 'recorded',
      refundId: created.id,
      status: PayHereRefundStatus.REQUIRES_REVIEW,
    };
  }

  private async reconcileRow(row: PayHereRefund) {
    if (!this.payhere) {
      throw new BadRequestException('PayHere is not enabled');
    }
    if (row.status === PayHereRefundStatus.SUCCEEDED) return;
    const now = new Date();
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: {
        paymentId: row.paymentId,
        providerPaymentId: row.payherePaymentId,
      },
      select: { merchantReference: true },
    });
    if (!attempt) {
      await this.touch(row.id, now);
      return;
    }
    const retrieved = await this.payhere.retrieveForRefund(
      attempt.merchantReference,
      row.payherePaymentId,
    );
    if (retrieved.kind !== 'matched') {
      await this.touch(row.id, now);
      return;
    }
    await this.applyRetrievedStatus(row, retrieved, now);
  }

  private async applyRetrievedStatus(
    row: PayHereRefund,
    retrieved: Extract<RetrievedRefundState, { kind: 'matched' }>,
    now: Date,
  ) {
    const providerStatus = retrieved.providerStatus;
    if (
      providerStatus === 'REFUND REQUESTED' ||
      providerStatus === 'REFUND PROCESSING'
    ) {
      await this.prisma.payHereRefund.update({
        where: { id: row.id },
        data: {
          status: PayHereRefundStatus.PROCESSING,
          retrySafe: false,
          openRefundSlot: row.openRefundSlot ?? row.paymentId,
          lastReconciledAt: now,
          failureMessage: null,
          sanitizedResponse: { retrievalStatus: providerStatus },
        },
      });
      return;
    }
    if (providerStatus === 'REFUNDED') {
      await this.prisma.payHereRefund.update({
        where: { id: row.id },
        data: {
          status: PayHereRefundStatus.SUCCEEDED,
          retrySafe: false,
          completedAt: row.completedAt ?? now,
          lastReconciledAt: now,
          failureMessage: null,
          sanitizedResponse: { retrievalStatus: providerStatus },
        },
      });
      await this.reverseIfPosted(row.appointmentId);
      return;
    }
    if (providerStatus === 'CHARGEBACKED') {
      await this.prisma.appointment.updateMany({
        where: { id: row.appointmentId },
        data: { manualReviewRequired: true },
      });
      await this.prisma.payHereRefund.update({
        where: { id: row.id },
        data: {
          status: PayHereRefundStatus.REQUIRES_REVIEW,
          retrySafe: false,
          openRefundSlot: row.openRefundSlot ?? row.paymentId,
          lastReconciledAt: now,
          failureMessage: 'PayHere reported a chargeback for this payment',
          sanitizedResponse: { retrievalStatus: providerStatus },
        },
      });
      return;
    }
    if (providerStatus === 'RECEIVED') {
      await this.prisma.payHereRefund.update({
        where: { id: row.id },
        data: {
          status: PayHereRefundStatus.FAILED,
          retrySafe: true,
          openRefundSlot: null,
          lastReconciledAt: now,
          failureMessage:
            'Retrieval shows the payment was received and no refund has started',
          sanitizedResponse: { retrievalStatus: providerStatus },
        },
      });
      return;
    }
    await this.touch(row.id, now);
  }

  private async loadEligible(appointmentId: string): Promise<
    | {
        appointmentId: string;
        paymentId: string;
        payherePaymentId: string;
        amount: Prisma.Decimal;
        currency: string;
        reason: PayHereRefundReason;
      }
    | { reason: string }
  > {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { payments: { include: { attempts: true } } },
    });
    if (!appointment) return { reason: 'not-found' };
    if (appointment.refundObligation !== RefundObligation.FULL_REFUND_DUE) {
      return { reason: 'no-obligation' };
    }
    const payment = appointment.payments.find(
      (row) => row.provider === PaymentProvider.PAYHERE,
    );
    if (!payment) return { reason: 'not-payhere' };
    if (payment.status !== PaymentStatus.PAID) {
      return {
        reason: payment.status === PaymentStatus.FAILED ? 'failed' : 'unpaid',
      };
    }
    const attempt = payment.attempts.find((row) => row.providerPaymentId);
    if (!attempt?.providerPaymentId) return { reason: 'missing-payment-id' };
    if (await this.hasChargeback(payment.id)) {
      await this.prisma.appointment.updateMany({
        where: { id: appointment.id },
        data: { manualReviewRequired: true },
      });
      return { reason: 'chargeback' };
    }
    return {
      appointmentId: appointment.id,
      paymentId: payment.id,
      payherePaymentId: attempt.providerPaymentId,
      amount: new Prisma.Decimal(payment.amount),
      currency: payment.currency,
      reason: reasonFor(appointment.status),
    };
  }

  private async hasChargeback(paymentId: string): Promise<boolean> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { paymentId },
      select: { merchantReference: true },
    });
    if (attempts.length === 0) return false;
    const found = await this.prisma.payHereNotification.findFirst({
      where: {
        statusCode: -3,
        merchantReference: {
          in: attempts.map((row) => row.merchantReference),
        },
      },
      select: { id: true },
    });
    return found !== null;
  }

  private async reverseIfPosted(appointmentId: string) {
    try {
      await this.ledger.reversePostedSnapshotForRefundObligation(appointmentId);
    } catch {
      // The PayHere record stays succeeded. The ledger method is idempotent
      // and can be run again without appending a second reversal.
    }
  }

  private async markUncertain(
    id: string,
    providerStatus: number,
    message: string,
  ) {
    await this.prisma.payHereRefund.update({
      where: { id },
      data: {
        status: PayHereRefundStatus.REQUIRES_REVIEW,
        providerStatus,
        retrySafe: false,
        failureMessage:
          message || 'PayHere refund outcome is uncertain and was not retried',
        sanitizedResponse: { status: providerStatus, msg: message },
      },
    });
  }

  private async releaseUnsent(id: string) {
    await this.prisma.payHereRefund.deleteMany({
      where: { id, status: PayHereRefundStatus.PROCESSING },
    });
  }

  private async touch(id: string, now: Date) {
    await this.prisma.payHereRefund.update({
      where: { id },
      data: { lastReconciledAt: now },
    });
  }

  private isRetryAllowed(row: PayHereRefund): boolean {
    return (
      row.status === PayHereRefundStatus.FAILED &&
      row.retrySafe &&
      !row.openRefundSlot
    );
  }
}

function reasonFor(status: AppointmentStatus): PayHereRefundReason {
  if (status === AppointmentStatus.PAYMENT_EXPIRED) {
    return PayHereRefundReason.RESERVATION_EXPIRED;
  }
  if (
    status === AppointmentStatus.NO_SHOW_ASTROLOGER ||
    status === AppointmentStatus.NO_SHOW_BOTH
  ) {
    return PayHereRefundReason.NO_SHOW;
  }
  return PayHereRefundReason.CANCELLATION;
}

function toView(row: PayHereRefund): RefundView {
  return {
    id: row.id,
    paymentId: row.paymentId,
    appointmentId: row.appointmentId,
    payherePaymentId: row.payherePaymentId,
    payhereRefundNumber: row.payhereRefundNumber,
    amount: toMoneyString(row.amount),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    retryAllowed:
      row.status === PayHereRefundStatus.FAILED &&
      row.retrySafe &&
      !row.openRefundSlot,
    failureMessage: row.failureMessage,
    providerStatus: row.providerStatus,
    sanitizedResponse: row.sanitizedResponse,
    initiatedAt: row.initiatedAt,
    lastReconciledAt: row.lastReconciledAt,
    completedAt: row.completedAt,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

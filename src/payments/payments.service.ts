import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ProposalStatus,
  RefundObligation,
  User,
  UserRole,
  type Appointment,
  type Payment,
  type PaymentAttempt,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AvailabilityService } from '../availability/availability.service';
import {
  PAYMENT_CURRENCY,
  PAYMENT_RESERVATION_MINUTES,
} from '../availability/availability.constants';
import { OccupancyService } from '../availability/occupancy.service';
import { BookingGuardService } from '../availability/booking-guard.service';
import { toMoneyString } from '../common/money/money';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { isMockPaymentCallbackAllowed } from '../config/runtime-safety';
import {
  assessBillingProfile,
  billingProfileIncompleteException,
} from '../users/billing-profile';
import {
  payHereErrorCategory,
  payHereErrorName,
  type PayHereLogSink,
} from './payhere/payhere-diagnostics';
import {
  createPayHereDiagnosticLogger,
  PAYHERE_FILE_LOG,
  type PayHereFileLogSink,
} from './payhere/payhere-file-log.sink';
import { PayHereNotificationError } from './payhere/payhere-signature';
import type { PayHereGateway } from './payhere/payhere.gateway';
import type { PaymentNotifyOutcome } from './payment-gateway';
import {
  toAppointmentView,
  toAstrologerAppointmentView,
  toCheckoutView,
} from './appointment.mapper';
import { CHECKOUT_BLOCKED_STATUSES } from './appointment.state';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PayHereRefundService } from './payhere-refund.service';

const appointmentInclude = {
  payments: { include: { attempts: true } },
} satisfies Prisma.AppointmentInclude;

type AppointmentLoaded = Appointment & {
  payments: Array<Payment & { attempts: PaymentAttempt[] }>;
};

@Injectable()
export class PaymentsService {
  private readonly logger: PayHereLogSink;

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly occupancy: OccupancyService,
    private readonly bookingGuard: BookingGuardService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly notifications: NotificationService,
    @Optional() private readonly refunds?: PayHereRefundService,
    @Optional()
    @Inject(PAYHERE_FILE_LOG)
    fileLog?: PayHereFileLogSink | null,
  ) {
    this.logger = createPayHereDiagnosticLogger(PaymentsService.name, {
      fileSink: fileLog === undefined ? undefined : fileLog,
    });
  }

  async checkout(user: User, consultationId: string, proposalId: string) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || consultation.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }
    if (consultation.status !== ConsultationStatus.ACCEPTED) {
      throw new ConflictException(
        `Cannot checkout when consultation status is ${consultation.status}`,
      );
    }

    const proposal = await this.prisma.consultationProposal.findFirst({
      where: { id: proposalId, consultationId },
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    if (proposal.status !== ProposalStatus.ACCEPTED) {
      throw new ConflictException(
        `Cannot checkout proposal in status ${proposal.status}`,
      );
    }

    const billing = assessBillingProfile(user);
    if (!billing.complete) {
      throw billingProfileIncompleteException(billing.missingFields);
    }

    const amount = toMoneyString(consultation.requestedPrice);
    const now = new Date();

    return this.bookingGuard.withAstrologerLock(
      consultation.astrologerId,
      async (tx) => {
        await this.occupancy.expireDueReservations(now, tx);

        const existing = await tx.appointment.findUnique({
          where: { proposalId },
          include: appointmentInclude,
        });

        if (existing && CHECKOUT_BLOCKED_STATUSES.includes(existing.status)) {
          throw new ConflictException(
            `Cannot checkout an appointment in status ${existing.status}`,
          );
        }

        if (existing?.status === AppointmentStatus.CONFIRMED) {
          return toCheckoutView(existing, {
            alreadyConfirmed: true,
          });
        }

        if (
          existing?.status === AppointmentStatus.PAYMENT_PENDING &&
          existing.reservationExpiresAt.getTime() > now.getTime()
        ) {
          const latest = latestAttempt(existing);
          if (savedCardChargeStillOpen(latest)) {
            throw new ConflictException(
              'A saved-card charge is already open for this appointment',
            );
          }
          if (!latest?.merchantReference.startsWith('sc_')) {
            const checkout =
              (latest?.checkoutPayload as Record<string, unknown> | null) ??
              (
                await this.gateway.createCheckout({
                  merchantReference:
                    latest?.merchantReference ??
                    this.newMerchantReference(existing.id),
                  amount,
                  currency: existing.currency,
                  appointmentId: existing.id,
                  consultationId,
                  customer: this.checkoutCustomer(user),
                })
              ).checkout;
            return toCheckoutView(existing, checkout);
          }
        }

        const occupied = await this.occupancy.loadOccupiedIntervals({
          astrologerId: consultation.astrologerId,
          excludeConsultationId: consultationId,
          now,
          db: tx,
        });
        await this.availability.assertProposedSlotEligible({
          astrologerId: consultation.astrologerId,
          proposedStartAt: proposal.proposedStartAt,
          durationMinutes: proposal.durationMinutes,
          occupied,
          now,
        });

        const expiresAt = new Date(
          now.getTime() + PAYMENT_RESERVATION_MINUTES * 60 * 1000,
        );

        let appointment: AppointmentLoaded;
        if (existing) {
          appointment = await tx.appointment.update({
            where: { id: existing.id },
            data: {
              status: AppointmentStatus.PAYMENT_PENDING,
              startAt: proposal.proposedStartAt,
              endAt: proposal.proposedEndAt,
              durationMinutes: proposal.durationMinutes,
              amount: consultation.requestedPrice,
              currency: PAYMENT_CURRENCY,
              reservationExpiresAt: expiresAt,
              confirmedAt: null,
            },
            include: appointmentInclude,
          });
        } else {
          appointment = await tx.appointment.create({
            data: {
              consultationId,
              proposalId,
              customerId: user.id,
              astrologerId: consultation.astrologerId,
              startAt: proposal.proposedStartAt,
              endAt: proposal.proposedEndAt,
              durationMinutes: proposal.durationMinutes,
              status: AppointmentStatus.PAYMENT_PENDING,
              amount: consultation.requestedPrice,
              currency: PAYMENT_CURRENCY,
              reservationExpiresAt: expiresAt,
            },
            include: appointmentInclude,
          });
        }

        let payment = appointment.payments[0];
        if (!payment) {
          payment = await tx.payment.create({
            data: {
              appointmentId: appointment.id,
              consultationId,
              amount: consultation.requestedPrice,
              currency: PAYMENT_CURRENCY,
              status: PaymentStatus.PENDING,
              provider: this.paymentProvider(),
            },
            include: { attempts: true },
          });
        } else if (payment.status !== PaymentStatus.PENDING) {
          payment = await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.PENDING,
              amount: consultation.requestedPrice,
              currency: PAYMENT_CURRENCY,
              paidAt: null,
              provider: this.paymentProvider(),
            },
            include: { attempts: true },
          });
        }

        const merchantReference = this.newMerchantReference(appointment.id);
        const { checkout } = await this.gateway.createCheckout({
          merchantReference,
          amount,
          currency: PAYMENT_CURRENCY,
          appointmentId: appointment.id,
          consultationId,
          customer: this.checkoutCustomer(user),
        });

        await tx.paymentAttempt.create({
          data: {
            paymentId: payment.id,
            provider: this.paymentProvider(),
            merchantReference,
            status: PaymentStatus.PENDING,
            checkoutPayload: checkout as Prisma.InputJsonValue,
          },
        });

        const fresh = await tx.appointment.findUniqueOrThrow({
          where: { id: appointment.id },
          include: appointmentInclude,
        });
        return toCheckoutView(fresh, checkout);
      },
    );
  }

  async getForCustomer(user: User, consultationId: string) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || consultation.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }
    await this.occupancy.expireDueReservations();
    const appointment = await this.prisma.appointment.findFirst({
      where: { consultationId },
      include: appointmentInclude,
      orderBy: { createdAt: 'desc' },
    });
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }
    return toAppointmentView(appointment);
  }

  /** Customer view: includes the customer's own payment and attempt. */
  async getSummaryForCustomer(consultationId: string) {
    await this.occupancy.expireDueReservations();
    const appointment = await this.prisma.appointment.findFirst({
      where: { consultationId },
      include: appointmentInclude,
      orderBy: { createdAt: 'desc' },
    });
    return appointment ? toAppointmentView(appointment) : null;
  }

  /**
   * Latest appointment per consultation for list rows (one query). Payment
   * data is never loaded, so list summaries cannot leak payment details.
   */
  async listLatestAppointmentViews(consultationIds: string[]) {
    const latest = new Map<
      string,
      ReturnType<typeof toAstrologerAppointmentView>
    >();
    if (consultationIds.length === 0) return latest;
    await this.occupancy.expireDueReservations();
    const rows = await this.prisma.appointment.findMany({
      where: { consultationId: { in: consultationIds } },
      orderBy: { createdAt: 'desc' },
    });
    for (const row of rows) {
      if (!latest.has(row.consultationId)) {
        latest.set(row.consultationId, toAstrologerAppointmentView(row));
      }
    }
    return latest;
  }

  /**
   * Astrologer view: payment data is not even loaded, so the customer's
   * payment attempt / merchant reference can never reach an astrologer.
   */
  async getSummaryForAstrologer(consultationId: string) {
    await this.occupancy.expireDueReservations();
    const appointment = await this.prisma.appointment.findFirst({
      where: { consultationId },
      orderBy: { createdAt: 'desc' },
    });
    return appointment ? toAstrologerAppointmentView(appointment) : null;
  }

  async syncForCustomer(user: User, consultationId: string) {
    const view = await this.getForCustomer(user, consultationId);
    const reference = view.payment?.latestAttempt?.merchantReference;
    if (
      !reference ||
      view.status === AppointmentStatus.CONFIRMED ||
      view.payment?.status === PaymentStatus.PAID
    ) {
      return view;
    }

    const verified = await this.gateway.verifyByReference(
      reference,
      {
        amount: view.amount,
        currency: view.currency,
      },
      { reason: 'customer_sync' },
    );
    if (!verified.success || verified.ambiguous || !verified.amount || !verified.currency) {
      return view;
    }
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { merchantReference: reference },
      select: { id: true, openChargeSlot: true },
    });
    await this.finalizeVerified({
      merchantReference: reference,
      providerPaymentId: verified.providerPaymentId ?? `verify_${reference}`,
      amount: verified.amount,
      currency: verified.currency,
      success: true,
      outcome: 'success',
      raw: { source: 'sync' },
    });
    const finalized = await this.getForCustomer(user, consultationId);
    this.logger.log({
      event: 'payhere.payment.finalized',
      attemptId: attempt?.id ?? null,
      merchantReference: reference,
      responseClassification: 'customer_sync:retrieval_confirmed',
      paymentState: finalized.payment?.status ?? null,
      appointmentState: finalized.status,
      reconciliationRequired:
        finalized.payment?.latestAttempt?.reconciliationRequired ?? null,
      chargeSlotOccupied: attempt?.openChargeSlot != null,
      source: 'customer_sync',
    });
    return finalized;
  }

  async handleMockNotify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    // Allowlist, not "anything but production": an unset or unknown NODE_ENV
    // keeps mock callbacks disabled.
    if (!isMockPaymentCallbackAllowed(process.env.NODE_ENV)) {
      throw new ForbiddenException('Mock payment callbacks are disabled');
    }
    let notify: Awaited<ReturnType<PaymentGateway['verifyNotify']>>;
    try {
      notify = await this.gateway.verifyNotify(headers, rawBody);
    } catch {
      throw new BadRequestException('Invalid mock payment callback body');
    }
    return this.finalizeVerified({
      ...(await this.withStoredCheckoutValues(notify)),
      raw: safeJson(rawBody),
    });
  }

  /**
   * PayHere server notification. The return URL is not accepted here.
   * Card fields are removed before anything is stored.
   */
  async handlePayHereNotify(fields: Record<string, string>) {
    if (this.gateway.provider !== 'PAYHERE') {
      throw new NotFoundException('PayHere notifications are not enabled');
    }
    const receivedAt = new Date().toISOString();
    const hintedReference =
      typeof fields.order_id === 'string' && fields.order_id.length > 0
        ? fields.order_id
        : null;
    this.logger.log({
      event: 'payhere.notify.received',
      receivedAt,
      merchantReference: hintedReference,
    });
    const gateway = this.gateway as PayHereGateway;
    let parsed: ReturnType<PayHereGateway['verifyNotification']>;
    try {
      parsed = gateway.verifyNotification(fields);
    } catch (error) {
      const category =
        error instanceof PayHereNotificationError
          ? payHereErrorCategory(error)
          : 'malformed';
      this.logger.warn({
        event:
          category === 'invalid_signature'
            ? 'payhere.notify.invalid_signature'
            : 'payhere.notify.rejected',
        receivedAt,
        merchantReference: hintedReference,
        signatureValid: category !== 'invalid_signature' ? null : false,
        outcome: 'rejected',
        errorCategory: category,
        errorName: payHereErrorName(error),
      });
      if (error instanceof PayHereNotificationError) {
        throw new BadRequestException('Invalid PayHere notification');
      }
      throw new BadRequestException('Malformed PayHere notification');
    }

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { merchantReference: parsed.merchantReference },
      select: { id: true },
    });
    if (!attempt) {
      this.logger.warn({
        event: 'payhere.notify.unknown_reference',
        receivedAt,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        outcome: 'unknown_reference',
        errorCategory: 'unknown_reference',
      });
      throw new NotFoundException('Payment attempt not found');
    }
    try {
      await this.recordPayHereNotification(parsed);

      if (parsed.outcome === 'pending') {
        this.logger.log({
          event: 'payhere.notify.processed',
          receivedAt,
          attemptId: attempt.id,
          merchantReference: parsed.merchantReference,
          signatureValid: true,
          outcome: 'pending',
        });
        return { pending: true };
      }
      if (parsed.outcome === 'chargedback') {
        await this.flagChargebackForReview(parsed.merchantReference);
        this.logger.log({
          event: 'payhere.notify.processed',
          receivedAt,
          attemptId: attempt.id,
          merchantReference: parsed.merchantReference,
          signatureValid: true,
          outcome: 'chargedback',
        });
        return { chargedback: true };
      }
      const result = await this.finalizeVerified({
        merchantReference: parsed.merchantReference,
        providerPaymentId:
          parsed.providerPaymentId || `payhere_${parsed.merchantReference}`,
        amount: parsed.amount,
        currency: parsed.currency,
        success: parsed.success,
        outcome: parsed.outcome,
        raw: parsed.sanitized,
      });
      const duplicate =
        result != null &&
        typeof result === 'object' &&
        ('alreadyPaid' in result || 'alreadyRecorded' in result);
      this.logger.log({
        event: duplicate
          ? 'payhere.notify.duplicate'
          : 'payhere.notify.processed',
        receivedAt,
        attemptId: attempt.id,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        outcome: duplicate
          ? 'duplicate'
          : parsed.success
            ? 'success'
            : (parsed.outcome ?? 'failed'),
      });
      return result;
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error({
        event: 'payhere.notify.exception',
        receivedAt,
        attemptId: attempt.id,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        outcome: 'exception',
        errorCategory: payHereErrorCategory(error),
        errorName: payHereErrorName(error),
      });
      throw error;
    }
  }

  /**
   * Mock gateway only. The mock stands in for a gateway that echoes what was
   * checked out, so a successful callback that omits amount/currency gets the
   * values stored with the checkout attempt (server-side data, never the
   * client's). Values the callback does supply are kept and compared.
   */
  private async withStoredCheckoutValues<
    T extends {
      merchantReference: string;
      success: boolean;
      amount: string;
      currency: string;
    },
  >(notify: T): Promise<T> {
    if (!notify.success || (notify.amount && notify.currency)) return notify;
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { merchantReference: notify.merchantReference },
      select: { checkoutPayload: true },
    });
    const stored = (attempt?.checkoutPayload ?? {}) as Record<string, unknown>;
    return {
      ...notify,
      amount:
        notify.amount ||
        (typeof stored.amount === 'string' ? stored.amount : ''),
      currency:
        notify.currency ||
        (typeof stored.currency === 'string' ? stored.currency : ''),
    };
  }

  async finalizeVerified(notify: {
    merchantReference: string;
    providerPaymentId: string;
    amount: string;
    currency: string;
    success: boolean;
    outcome?: PaymentNotifyOutcome;
    raw?: Prisma.InputJsonValue;
  }) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { merchantReference: notify.merchantReference },
      include: {
        payment: {
          include: { appointment: true },
        },
      },
    });
    if (!attempt) {
      throw new NotFoundException('Payment attempt not found');
    }

    const payment = attempt.payment;
    const appointment = payment.appointment;
    const expectedAmount = toMoneyString(appointment.amount);
    const now = new Date();
    const outcome: PaymentNotifyOutcome =
      notify.outcome ?? (notify.success ? 'success' : 'failed');

    if (notify.raw) {
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          rawNotifyPayload: stripCardFields(notify.raw),
          providerPaymentId:
            attempt.providerPaymentId ??
            (notify.providerPaymentId || null),
        },
      });
    }

    if (outcome === 'chargedback') {
      return { chargedback: true };
    }
    if (outcome === 'pending') {
      return { pending: true };
    }

    const holdLive =
      appointment.status === AppointmentStatus.PAYMENT_PENDING &&
      appointment.reservationExpiresAt.getTime() > now.getTime();

    if (payment.status === PaymentStatus.PAID && !notify.success) {
      return {
        alreadyPaid: true,
        appointment: await this.reloadAppointment(appointment.id),
      };
    }

    if (
      payment.status === PaymentStatus.PAID &&
      (appointment.status === AppointmentStatus.CONFIRMED || holdLive)
    ) {
      return {
        alreadyPaid: true,
        appointment: await this.reloadAppointment(appointment.id),
      };
    }

    if (payment.status === PaymentStatus.PAID) {
      const row = await this.prisma.$transaction((tx) =>
        this.persistCapturedAfterExpiry(tx, {
          attemptId: attempt.id,
          paymentId: payment.id,
          appointmentId: appointment.id,
          providerPaymentId: notify.providerPaymentId,
          now,
        }),
      );
      await this.noteCapturedRefund(appointment.id);
      return {
        capturedAfterExpiry: true,
        alreadyRecorded: true,
        appointment: toAppointmentView(row),
      };
    }

    // Callback ordering:
    //  - success then failure: a confirmed PAID payment ignores the late failure.
    //  - failure then success: a later verified success is authoritative while
    //    the hold is still live.
    if (!notify.success) {
      await this.recordFailure(attempt.id, payment.id);
      return { failed: true };
    }

    // A success must come with its own verified amount and currency. Nothing
    // is changed when they are missing, so a complete callback can still land.
    if (!notify.amount || !notify.currency) {
      throw new BadRequestException(
        'Verified payment result must include amount and currency',
      );
    }
    if (!amountsEqual(notify.amount, expectedAmount)) {
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      throw new ConflictException('Payment amount does not match reservation');
    }
    if (notify.currency !== appointment.currency) {
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      throw new ConflictException(
        'Payment currency does not match reservation',
      );
    }

    const capturedHold =
      appointment.status !== AppointmentStatus.PAYMENT_PENDING ||
      appointment.reservationExpiresAt.getTime() <= now.getTime();
    if (capturedHold) {
      const row = await this.prisma.$transaction((tx) =>
        this.persistCapturedAfterExpiry(tx, {
          attemptId: attempt.id,
          paymentId: payment.id,
          appointmentId: appointment.id,
          providerPaymentId: notify.providerPaymentId,
          now,
        }),
      );
      await this.noteCapturedRefund(appointment.id);
      return {
        capturedAfterExpiry: true,
        appointment: toAppointmentView(row),
      };
    }

    const confirmed = await this.bookingGuard.withAstrologerLock(
      appointment.astrologerId,
      async (tx) => {
        const updatedAppointment = await tx.appointment.updateMany({
          where: {
            id: appointment.id,
            status: AppointmentStatus.PAYMENT_PENDING,
            reservationExpiresAt: { gt: now },
          },
          data: {
            status: AppointmentStatus.CONFIRMED,
            confirmedAt: now,
          },
        });
        if (updatedAppointment.count === 0) {
          const current = await tx.appointment.findUniqueOrThrow({
            where: { id: appointment.id },
          });
          if (current.status === AppointmentStatus.CONFIRMED) {
            // Lost the race to another confirmation: the winner already
            // recorded the notifications, so this path creates none.
            return {
              row: await tx.appointment.findUniqueOrThrow({
                where: { id: appointment.id },
                include: appointmentInclude,
              }),
              notificationIds: [] as Array<string | null>,
            };
          }
          if (
            current.status === AppointmentStatus.PAYMENT_EXPIRED ||
            current.reservationExpiresAt.getTime() <= now.getTime()
          ) {
            return {
              row: await this.persistCapturedAfterExpiry(tx, {
                attemptId: attempt.id,
                paymentId: payment.id,
                appointmentId: appointment.id,
                providerPaymentId: notify.providerPaymentId,
                now,
              }),
              notificationIds: [] as Array<string | null>,
              capturedAfterExpiry: true,
            };
          }
          throw new ConflictException(
            'Reservation has expired; payment will not confirm the appointment',
          );
        }

        // Invariant: the appointment is CONFIRMED only together with a PAID
        // payment. A previously FAILED payment/attempt may be paid by a later
        // verified success; any other state aborts the whole transaction, so
        // the guarded confirmation above is rolled back too.
        const paid = await tx.payment.updateMany({
          where: {
            id: payment.id,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          },
          data: { status: PaymentStatus.PAID, paidAt: now },
        });
        if (paid.count === 0) {
          throw new ConflictException(
            'Payment is not in a payable state; the appointment was not confirmed',
          );
        }
        await tx.paymentAttempt.updateMany({
          where: {
            id: attempt.id,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          },
          data: {
            status: PaymentStatus.PAID,
            providerPaymentId: notify.providerPaymentId,
            requiresReview: false,
            openChargeSlot: null,
          },
        });

        // Authoritative transition: the guarded update above changed exactly
        // one row (PAYMENT_PENDING -> CONFIRMED). Record one notification per
        // recipient in this same transaction; duplicates/failed/expired paths
        // never reach this point.
        const ref = {
          type: 'APPOINTMENT_CONFIRMED' as const,
          consultationId: appointment.consultationId,
          appointmentId: appointment.id,
        };
        const notificationIds = [
          await this.notifications.notifyUser(tx, appointment.customerId, ref),
          await this.notifications.notifyAstrologerProfile(
            tx,
            appointment.astrologerId,
            ref,
          ),
        ];

        return {
          row: await tx.appointment.findUniqueOrThrow({
            where: { id: appointment.id },
            include: appointmentInclude,
          }),
          notificationIds,
        };
      },
    );

    if ('capturedAfterExpiry' in confirmed && confirmed.capturedAfterExpiry) {
      await this.noteCapturedRefund(appointment.id);
      return {
        capturedAfterExpiry: true,
        appointment: toAppointmentView(confirmed.row),
      };
    }

    // Lock released and transaction committed: start delivery now.
    this.notifications.deliverAfterCommit(confirmed.notificationIds);

    return { appointment: toAppointmentView(confirmed.row) };
  }

  /**
   * Failure callback. Fails only the attempt (if still pending); the payment is
   * failed only when no other attempt is still pending. One transaction, so the
   * attempt/payment pair never diverges. Never touches PAID/EXPIRED rows.
   */
  private async noteCapturedRefund(appointmentId: string) {
    if (!this.refunds) return;
    try {
      await this.refunds.requestForAppointment(appointmentId);
    } catch {
      // The payment and FULL_REFUND_DUE are already committed. The sweep can
      // start the refund later. A thrown error must not undo the capture.
    }
  }

  /**
   * Status -3 is not a successful payment and does not start a refund.
   * Manual review blocks a later settlement credit. A snapshot that was already
   * posted is not reversed here.
   */
  private async flagChargebackForReview(merchantReference: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { merchantReference },
      select: { payment: { select: { appointmentId: true } } },
    });
    if (!attempt) return;
    await this.prisma.appointment.updateMany({
      where: { id: attempt.payment.appointmentId },
      data: { manualReviewRequired: true },
    });
  }

  private async recordFailure(attemptId: string, paymentId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.updateMany({
        where: { id: attemptId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      const stillPending = await tx.paymentAttempt.count({
        where: { paymentId, status: PaymentStatus.PENDING },
      });
      if (stillPending === 0) {
        await tx.payment.updateMany({
          where: { id: paymentId, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED },
        });
      }
    });
  }

  private async reloadAppointment(appointmentId: string) {
    return toAppointmentView(
      await this.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
        include: appointmentInclude,
      }),
    );
  }

  private paymentProvider(): PaymentProvider {
    return this.gateway.provider === 'PAYHERE'
      ? PaymentProvider.PAYHERE
      : PaymentProvider.MOCK;
  }

  private checkoutCustomer(user: User) {
    const billing = assessBillingProfile(user);
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      firstName: billing.firstName ?? undefined,
      lastName: billing.lastName ?? undefined,
      email: billing.email ?? undefined,
      address: billing.address ?? undefined,
      city: billing.city ?? undefined,
      country: billing.country ?? undefined,
    };
  }

  private async recordPayHereNotification(
    parsed: ReturnType<PayHereGateway['verifyNotification']>,
  ) {
    let amount: Prisma.Decimal | null = null;
    try {
      amount = parsed.amount ? new Prisma.Decimal(parsed.amount) : null;
    } catch {
      amount = null;
    }
    try {
      await this.prisma.payHereNotification.create({
        data: {
          merchantReference: parsed.merchantReference,
          payherePaymentId: parsed.providerPaymentId,
          statusCode: parsed.statusCode,
          amount,
          currency: parsed.currency || null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * A verified capture after the 30-minute hold. The appointment is not
   * confirmed, the slot is not held, and the refund is only an obligation.
   */
  private async persistCapturedAfterExpiry(
    tx: Prisma.TransactionClient,
    input: {
      attemptId: string;
      paymentId: string;
      appointmentId: string;
      providerPaymentId: string;
      now: Date;
    },
  ) {
    await tx.payment.updateMany({
      where: {
        id: input.paymentId,
        status: {
          in: [
            PaymentStatus.PENDING,
            PaymentStatus.FAILED,
            PaymentStatus.EXPIRED,
          ],
        },
      },
      data: { status: PaymentStatus.PAID, paidAt: input.now },
    });
    await tx.paymentAttempt.updateMany({
      where: {
        id: input.attemptId,
        status: {
          in: [
            PaymentStatus.PENDING,
            PaymentStatus.FAILED,
            PaymentStatus.EXPIRED,
          ],
        },
      },
      data: {
        status: PaymentStatus.PAID,
        providerPaymentId: input.providerPaymentId || null,
        requiresReview: false,
        openChargeSlot: null,
      },
    });
    await tx.appointment.updateMany({
      where: {
        id: input.appointmentId,
        status: AppointmentStatus.PAYMENT_PENDING,
        reservationExpiresAt: { lte: input.now },
      },
      data: { status: AppointmentStatus.PAYMENT_EXPIRED },
    });
    await tx.appointment.updateMany({
      where: {
        id: input.appointmentId,
        status: { not: AppointmentStatus.CONFIRMED },
        refundObligation: null,
      },
      data: {
        refundObligation: RefundObligation.FULL_REFUND_DUE,
        refundObligationRecordedAt: input.now,
      },
    });
    return tx.appointment.findUniqueOrThrow({
      where: { id: input.appointmentId },
      include: appointmentInclude,
    });
  }

  private newMerchantReference(appointmentId: string) {
    return `wp_${appointmentId}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
}

function stripCardFields(value: Prisma.InputJsonValue): Prisma.InputJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, Prisma.InputJsonValue>) };
  delete copy.card_holder_name;
  delete copy.card_no;
  delete copy.card_expiry;
  delete copy.md5sig;
  delete copy.customer_token;
  delete copy.authorization_token;
  return copy;
}

function savedCardChargeStillOpen(attempt: {
  openChargeSlot?: string | null;
  requiresReview?: boolean;
  merchantReference?: string;
  status?: PaymentStatus;
} | undefined): boolean {
  if (!attempt) return false;
  if (attempt.openChargeSlot) return true;
  if (attempt.requiresReview) return true;
  return (
    typeof attempt.merchantReference === 'string' &&
    attempt.merchantReference.startsWith('sc_') &&
    attempt.status === PaymentStatus.PENDING
  );
}

function latestAttempt(appointment: AppointmentLoaded) {
  const attempts = appointment.payments[0]?.attempts ?? [];
  return [...attempts].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
}

/** Exact decimal comparison; an unparsable amount never matches. */
function amountsEqual(received: string, expected: string): boolean {
  try {
    return new Prisma.Decimal(received).equals(new Prisma.Decimal(expected));
  } catch {
    return false;
  }
}

function safeJson(raw: string): Prisma.InputJsonValue {
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    return { raw };
  }
}

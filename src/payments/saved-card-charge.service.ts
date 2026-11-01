import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
  SavedCardConsentEventType,
  SavedCardStatus,
  UserRole,
  type Appointment,
  type Payment,
  type PaymentAttempt,
  type User,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PAYMENT_CURRENCY,
  PAYMENT_RESERVATION_MINUTES,
} from '../availability/availability.constants';
import { AvailabilityService } from '../availability/availability.service';
import { BookingGuardService } from '../availability/booking-guard.service';
import { OccupancyService } from '../availability/occupancy.service';
import { toMoneyString } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import {
  assessBillingProfile,
  billingProfileIncompleteException,
} from '../users/billing-profile';
import { CHECKOUT_BLOCKED_STATUSES } from './appointment.state';
import { PaymentsService } from './payments.service';
import { PAYHERE_MERCHANT } from './payhere-refund.service';
import {
  PayHereChargeNotSentError,
  PayHereRateLimitError,
  type PayHereChargeCall,
  type PayHereGateway,
} from './payhere/payhere.gateway';
import { AUTOMATIC_PAYMENT_CONSENT_VERSION } from './saved-card.consent';
import { SavedCardService, savedCardIsChargeable } from './saved-card.service';

const appointmentInclude = {
  payments: { include: { attempts: true } },
} satisfies Prisma.AppointmentInclude;

type AppointmentLoaded = Appointment & {
  payments: Array<Payment & { attempts: PaymentAttempt[] }>;
};

export type SavedCardChargeView = {
  provider: 'PAYHERE';
  attemptStatus: PaymentStatus;
  merchantReference: string;
  appointmentStatus: AppointmentStatus;
  reconciliationRequired: boolean;
  refundObligation: RefundObligation | null;
};

type Claimed = {
  kind: 'claimed';
  attemptId: string;
  merchantReference: string;
  appointmentId: string;
  amount: string;
};

type ClaimResult = Claimed | { kind: 'existing'; view: SavedCardChargeView };

/**
 * Explicit saved-card capture for one accepted consultation.
 * The customer must call this route. Accepting a proposal does not charge.
 */
@Injectable()
export class SavedCardChargeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly occupancy: OccupancyService,
    private readonly bookingGuard: BookingGuardService,
    private readonly savedCards: SavedCardService,
    private readonly payments: PaymentsService,
    @Optional()
    @Inject(PAYHERE_MERCHANT)
    private readonly payhere?: PayHereGateway | null,
  ) {}

  async charge(
    user: User,
    consultationId: string,
    proposalId: string,
  ): Promise<SavedCardChargeView> {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    if (!this.payhere) {
      throw new BadRequestException(
        'Saved-card charging requires PAYHERE_MODE=sandbox or live',
      );
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
    if (!proposal) throw new NotFoundException('Proposal not found');
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
    await this.assertChargeableCard(user.id);
    if (!this.payhere.hasMerchantCapacity(2)) {
      throw new HttpException(
        'PayHere is temporarily unavailable. Try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const claimed = await this.claim(user, consultation, proposal, amount);
    if (claimed.kind === 'existing') return claimed.view;

    const cardId = await this.cardIdOrRelease(user.id, claimed.attemptId);
    let token: string;
    try {
      token = await this.savedCards.readActiveToken(user.id, cardId);
    } catch {
      await this.releaseUnsent(claimed.attemptId);
      throw new ConflictException(
        'No saved card is authorized for automatic payment',
      );
    }
    let result: PayHereChargeCall;
    try {
      result = await this.payhere.chargePayment(
        {
          orderId: claimed.merchantReference,
          amount: claimed.amount,
          currency: PAYMENT_CURRENCY,
          customerToken: token,
        },
        {
          beforeDispatch: () =>
            this.authorizeDispatch(user.id, cardId, claimed.attemptId),
        },
      );
    } catch (error) {
      if (
        error instanceof PayHereChargeNotSentError ||
        error instanceof PayHereRateLimitError
      ) {
        await this.releaseUnsent(claimed.attemptId);
        throw new HttpException(
          'Saved-card payment was not sent. You can try again.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      await this.markUncertain(claimed.attemptId);
      return this.viewFor(claimed.appointmentId, claimed.attemptId);
    }
    return this.applyResult(claimed, result);
  }

  async listForAdmin(page = 1, pageSize = 20) {
    const where = {
      requiresReview: true,
      merchantReference: { startsWith: 'sc_' },
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentAttempt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { payment: { include: { appointment: true } } },
      }),
      this.prisma.paymentAttempt.count({ where }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        id: row.id,
        merchantReference: row.merchantReference,
        status: row.status,
        reconciliationRequired: true,
        amount: toMoneyString(row.payment.amount),
        currency: row.payment.currency,
        appointmentStatus: row.payment.appointment.status,
        refundObligation: row.payment.appointment.refundObligation,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Retrieval only. A missing or ambiguous result stays unresolved and does
   * not start another charge.
   */
  async reconcileOne(attemptId: string): Promise<SavedCardChargeView> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: { payment: { include: { appointment: true } } },
    });
    if (!attempt || !attempt.merchantReference.startsWith('sc_')) {
      throw new NotFoundException('Saved-card charge not found');
    }
    if (!attempt.requiresReview && !attempt.openChargeSlot) {
      return this.viewFor(attempt.payment.appointmentId, attempt.id);
    }
    if (!this.payhere) {
      throw new BadRequestException(
        'Saved-card reconciliation requires PAYHERE_MODE=sandbox or live',
      );
    }
    const verified = await this.payhere.verifyByReference(
      attempt.merchantReference,
      {
        amount: toMoneyString(attempt.payment.amount),
        currency: attempt.payment.currency,
        providerPaymentId: attempt.providerPaymentId ?? undefined,
      },
    );
    if (
      verified.success &&
      !verified.ambiguous &&
      verified.providerPaymentId &&
      verified.amount &&
      verified.currency
    ) {
      await this.payments.finalizeVerified({
        merchantReference: attempt.merchantReference,
        providerPaymentId: verified.providerPaymentId,
        amount: verified.amount,
        currency: verified.currency,
        success: true,
        outcome: 'success',
        raw: { source: 'saved-card-retrieval' },
      });
    }
    return this.viewFor(attempt.payment.appointmentId, attempt.id);
  }

  async reconcileUnresolved(): Promise<{ checked: number }> {
    if (!this.payhere) return { checked: 0 };
    const rows = await this.prisma.paymentAttempt.findMany({
      where: { requiresReview: true, merchantReference: { startsWith: 'sc_' } },
      orderBy: { updatedAt: 'asc' },
      take: 20,
      select: { id: true },
    });
    let checked = 0;
    for (const row of rows) {
      checked += 1;
      try {
        await this.reconcileOne(row.id);
      } catch {
        // One failed lookup must not stop the rest or start a new charge.
      }
    }
    return { checked };
  }

  private async claim(
    user: User,
    consultation: {
      id: string;
      astrologerId: string;
      requestedPrice: Prisma.Decimal;
    },
    proposal: {
      id: string;
      proposedStartAt: Date;
      proposedEndAt: Date;
      durationMinutes: number;
    },
    amount: string,
  ): Promise<ClaimResult> {
    const now = new Date();
    return this.bookingGuard.withAstrologerLock(
      consultation.astrologerId,
      async (tx) => {
        await this.occupancy.expireDueReservations(now, tx);
        const existing = await tx.appointment.findUnique({
          where: { proposalId: proposal.id },
          include: appointmentInclude,
        });
        if (existing && CHECKOUT_BLOCKED_STATUSES.includes(existing.status)) {
          throw new ConflictException(
            `Cannot checkout an appointment in status ${existing.status}`,
          );
        }
        if (existing?.status === AppointmentStatus.CONFIRMED) {
          return {
            kind: 'existing' as const,
            view: toChargeView(existing, latestAttempt(existing)),
          };
        }
        const attempts = existing?.payments.flatMap((row) => row.attempts) ?? [];
        const blocking = attempts.find(
          (row) =>
            Boolean(row.openChargeSlot) ||
            row.requiresReview ||
            (row.merchantReference.startsWith('sc_') &&
              row.status === PaymentStatus.PENDING),
        );
        if (blocking && existing) {
          if (
            blocking.openChargeSlot &&
            !blocking.requiresReview &&
            blocking.status === PaymentStatus.PENDING
          ) {
            await tx.paymentAttempt.update({
              where: { id: blocking.id },
              data: { requiresReview: true },
            });
            blocking.requiresReview = true;
          }
          return { kind: 'existing' as const, view: toChargeView(existing, blocking) };
        }
        if (existing?.payments.some((row) => row.status === PaymentStatus.PAID)) {
          return {
            kind: 'existing' as const,
            view: toChargeView(existing, latestAttempt(existing)),
          };
        }
        const manualPending = attempts.find(
          (row) =>
            row.status === PaymentStatus.PENDING &&
            !row.merchantReference.startsWith('sc_') &&
            existing?.status === AppointmentStatus.PAYMENT_PENDING &&
            existing.reservationExpiresAt.getTime() > now.getTime(),
        );
        if (manualPending) {
          throw new ConflictException(
            'A manual checkout is already open for this appointment',
          );
        }

        let appointment: AppointmentLoaded;
        if (
          existing?.status === AppointmentStatus.PAYMENT_PENDING &&
          existing.reservationExpiresAt.getTime() > now.getTime()
        ) {
          appointment = existing;
        } else {
          const occupied = await this.occupancy.loadOccupiedIntervals({
            astrologerId: consultation.astrologerId,
            excludeConsultationId: consultation.id,
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
          appointment = existing
            ? await tx.appointment.update({
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
              })
            : await tx.appointment.create({
                data: {
                  consultationId: consultation.id,
                  proposalId: proposal.id,
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
              consultationId: consultation.id,
              amount: consultation.requestedPrice,
              currency: PAYMENT_CURRENCY,
              status: PaymentStatus.PENDING,
              provider: PaymentProvider.PAYHERE,
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
              provider: PaymentProvider.PAYHERE,
            },
            include: { attempts: true },
          });
        }

        const merchantReference = `sc_${randomUUID().replace(/-/g, '')}`;
        try {
          const attempt = await tx.paymentAttempt.create({
            data: {
              paymentId: payment.id,
              provider: PaymentProvider.PAYHERE,
              merchantReference,
              status: PaymentStatus.PENDING,
              checkoutPayload: Prisma.JsonNull,
              openChargeSlot: payment.id,
              requiresReview: false,
            },
          });
          return {
            kind: 'claimed' as const,
            attemptId: attempt.id,
            merchantReference,
            appointmentId: appointment.id,
            amount,
          };
        } catch (error) {
          if (!isUniqueConflict(error)) throw error;
          const open = await tx.paymentAttempt.findFirst({
            where: { openChargeSlot: payment.id },
          });
          if (!open) throw error;
          return {
            kind: 'existing' as const,
            view: toChargeView(appointment, open),
          };
        }
      },
    );
  }

  /**
   * The synchronous Charging API body is only a hint. Payment is finalized
   * only when Retrieval returns one RECEIVED row for this order, amount, and
   * currency. A payment id from the response is a consistency check, not proof.
   * Anything else stays on this attempt for review. This never starts a charge.
   */
  private async applyResult(
    claimed: Claimed,
    result: PayHereChargeCall,
  ): Promise<SavedCardChargeView> {
    const hintedPaymentId =
      result.kind === 'reported' ? result.providerPaymentId : undefined;
    let verified: Awaited<ReturnType<PayHereGateway['verifyByReference']>>;
    try {
      verified = await this.payhere!.verifyByReference(
        claimed.merchantReference,
        {
          amount: claimed.amount,
          currency: PAYMENT_CURRENCY,
          providerPaymentId: hintedPaymentId,
        },
      );
    } catch {
      await this.markUncertain(claimed.attemptId);
      return this.viewFor(claimed.appointmentId, claimed.attemptId);
    }
    if (
      verified.success &&
      !verified.ambiguous &&
      verified.providerPaymentId &&
      verified.amount &&
      verified.currency
    ) {
      try {
        await this.payments.finalizeVerified({
          merchantReference: claimed.merchantReference,
          providerPaymentId: verified.providerPaymentId,
          amount: verified.amount,
          currency: verified.currency,
          success: true,
          outcome: 'success',
          raw: { source: 'saved-card-retrieval' },
        });
      } catch {
        await this.markUncertain(claimed.attemptId);
      }
      return this.viewFor(claimed.appointmentId, claimed.attemptId);
    }
    await this.markUncertain(claimed.attemptId);
    return this.viewFor(claimed.appointmentId, claimed.attemptId);
  }

  /**
   * After OAuth, lock the saved card and re-read consent. The charge POST is
   * allowed only when this transaction commits the dispatch marker first.
   * The transaction ends before the HTTP request. A later revocation can
   * delete the token for future charges, but it cannot cancel a request that
   * this marker already authorized.
   */
  private async authorizeDispatch(
    userId: string,
    cardId: string,
    attemptId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT \`id\`
        FROM \`SavedPaymentMethod\`
        WHERE \`id\` = ${cardId} AND \`userId\` = ${userId}
        FOR UPDATE
      `;
      if (locked.length !== 1) return false;
      const authorized = await this.readAuthorizedCardId(tx, userId, cardId);
      if (!authorized) return false;
      const marked = await tx.paymentAttempt.updateMany({
        where: {
          id: attemptId,
          status: PaymentStatus.PENDING,
          providerPaymentId: null,
          requiresReview: false,
          openChargeSlot: { not: null },
        },
        data: {
          checkoutPayload: {
            dispatchAuthorizedAt: new Date().toISOString(),
          },
        },
      });
      return marked.count === 1;
    });
  }

  private async markUncertain(attemptId: string) {
    await this.prisma.paymentAttempt.updateMany({
      where: { id: attemptId, status: PaymentStatus.PENDING },
      data: { requiresReview: true },
    });
  }

  private async releaseUnsent(attemptId: string) {
    await this.prisma.paymentAttempt.updateMany({
      where: {
        id: attemptId,
        status: PaymentStatus.PENDING,
        providerPaymentId: null,
        requiresReview: false,
      },
      data: {
        status: PaymentStatus.FAILED,
        openChargeSlot: null,
      },
    });
  }

  private async assertChargeableCard(userId: string): Promise<string> {
    const cardId = await this.readAuthorizedCardId(this.prisma, userId);
    if (!cardId) {
      throw new ConflictException(
        'No saved card is authorized for automatic payment',
      );
    }
    return cardId;
  }

  private async readAuthorizedCardId(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    cardId?: string,
  ): Promise<string | null> {
    const card = await db.savedPaymentMethod.findFirst({
      where: {
        userId,
        ...(cardId ? { id: cardId } : {}),
        status: SavedCardStatus.ACTIVE,
        authorizationEnabled: true,
        revokedAt: null,
        removedAt: null,
      },
    });
    if (
      !card ||
      !savedCardIsChargeable(card) ||
      card.consentVersion !== AUTOMATIC_PAYMENT_CONSENT_VERSION
    ) {
      return null;
    }
    const [granted, revoked] = await Promise.all([
      db.savedCardConsentEvent.findFirst({
        where: {
          savedPaymentMethodId: card.id,
          type: SavedCardConsentEventType.CONSENT_GRANTED,
          consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
        },
      }),
      db.savedCardConsentEvent.findFirst({
        where: {
          savedPaymentMethodId: card.id,
          type: SavedCardConsentEventType.CONSENT_REVOKED,
        },
      }),
    ]);
    if (!granted || revoked) return null;
    return card.id;
  }

  private async cardIdOrRelease(userId: string, attemptId: string) {
    try {
      return await this.assertChargeableCard(userId);
    } catch (error) {
      await this.releaseUnsent(attemptId);
      throw error;
    }
  }

  private async viewFor(
    appointmentId: string,
    attemptId: string,
  ): Promise<SavedCardChargeView> {
    const appointment = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: appointmentInclude,
    });
    const attempt =
      appointment.payments
        .flatMap((row) => row.attempts)
        .find((row) => row.id === attemptId) ?? latestAttempt(appointment);
    return toChargeView(appointment, attempt);
  }
}

function toChargeView(
  appointment: AppointmentLoaded,
  attempt: PaymentAttempt | undefined,
): SavedCardChargeView {
  const open =
    Boolean(attempt?.openChargeSlot) &&
    attempt?.status !== PaymentStatus.PAID;
  return {
    provider: 'PAYHERE',
    attemptStatus: attempt?.status ?? PaymentStatus.PENDING,
    merchantReference: attempt?.merchantReference ?? '',
    appointmentStatus: appointment.status,
    reconciliationRequired: attempt?.requiresReview === true || open,
    refundObligation: appointment.refundObligation,
  };
}

function latestAttempt(appointment: AppointmentLoaded) {
  const attempts = appointment.payments.flatMap((row) => row.attempts);
  return [...attempts].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

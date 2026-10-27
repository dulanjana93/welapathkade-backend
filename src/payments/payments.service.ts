import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentProvider,
  PaymentStatus,
  ProposalStatus,
  User,
  UserRole,
  type Appointment,
  Prisma,
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
  toAppointmentView,
  toAstrologerAppointmentView,
  toCheckoutView,
} from './appointment.mapper';
import { CHECKOUT_BLOCKED_STATUSES } from './appointment.state';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';

const appointmentInclude = {
  payments: { include: { attempts: true } },
} satisfies Prisma.AppointmentInclude;

type AppointmentLoaded = Appointment & {
  payments: Array<Payment & { attempts: PaymentAttempt[] }>;
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly occupancy: OccupancyService,
    private readonly bookingGuard: BookingGuardService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly notifications: NotificationService,
  ) {}

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
                customer: { id: user.id, name: user.name, phone: user.phone },
              })
            ).checkout;
          return toCheckoutView(existing, checkout);
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
              provider: PaymentProvider.MOCK,
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
          customer: { id: user.id, name: user.name, phone: user.phone },
        });

        await tx.paymentAttempt.create({
          data: {
            paymentId: payment.id,
            provider: PaymentProvider.MOCK,
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

    const verified = await this.gateway.verifyByReference(reference);
    // A verified result without its own amount and currency is not enough to
    // confirm anything: never substitute the expected values.
    if (verified.success && verified.amount && verified.currency) {
      await this.finalizeVerified({
        merchantReference: reference,
        providerPaymentId: verified.providerPaymentId ?? `verify_${reference}`,
        amount: verified.amount,
        currency: verified.currency,
        success: true,
        raw: { source: 'sync' },
      });
      return this.getForCustomer(user, consultationId);
    }
    return view;
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

    if (notify.raw) {
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          rawNotifyPayload: notify.raw,
          providerPaymentId:
            attempt.providerPaymentId ?? notify.providerPaymentId,
        },
      });
    }

    if (payment.status === PaymentStatus.PAID) {
      return {
        alreadyPaid: true,
        appointment: toAppointmentView(
          await this.prisma.appointment.findUniqueOrThrow({
            where: { id: appointment.id },
            include: appointmentInclude,
          }),
        ),
      };
    }

    // Callback ordering:
    //  - success then failure: PAID is terminal; the late failure returned
    //    above as `alreadyPaid` and changes nothing.
    //  - failure then success: a failure only fails the attempt (and the
    //    payment once no attempt is pending); a later verified success is
    //    authoritative and is accepted below while the hold is live.
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

    if (
      appointment.status !== AppointmentStatus.PAYMENT_PENDING ||
      appointment.reservationExpiresAt.getTime() <= now.getTime()
    ) {
      await this.occupancy.expireDueReservations(now);
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.EXPIRED },
      });
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.EXPIRED },
      });
      throw new ConflictException(
        'Reservation has expired; payment will not confirm the appointment',
      );
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

    // Lock released and transaction committed: start delivery now.
    this.notifications.deliverAfterCommit(confirmed.notificationIds);

    return { appointment: toAppointmentView(confirmed.row) };
  }

  /**
   * Failure callback. Fails only the attempt (if still pending); the payment is
   * failed only when no other attempt is still pending. One transaction, so the
   * attempt/payment pair never diverges. Never touches PAID/EXPIRED rows.
   */
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

  private newMerchantReference(appointmentId: string) {
    return `wp_${appointmentId}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
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

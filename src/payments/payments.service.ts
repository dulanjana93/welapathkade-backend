import {
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
  type Payment,
  type PaymentAttempt,
  type Prisma,
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
import { toAppointmentView, toCheckoutView } from './appointment.mapper';
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

  async getSummaryForConsultation(consultationId: string) {
    await this.occupancy.expireDueReservations();
    const appointment = await this.prisma.appointment.findFirst({
      where: { consultationId },
      include: appointmentInclude,
      orderBy: { createdAt: 'desc' },
    });
    return appointment ? toAppointmentView(appointment) : null;
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
    if (verified.success) {
      await this.finalizeVerified({
        merchantReference: reference,
        providerPaymentId: verified.providerPaymentId ?? `verify_${reference}`,
        amount: verified.amount ?? view.amount,
        currency: verified.currency ?? view.currency,
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
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Mock payment callbacks are disabled');
    }
    const notify = await this.gateway.verifyNotify(headers, rawBody);
    return this.finalizeVerified({
      ...notify,
      raw: safeJson(rawBody),
    });
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

    if (!notify.success) {
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      return { failed: true };
    }

    if (notify.amount && notify.amount !== expectedAmount) {
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      throw new ConflictException('Payment amount does not match reservation');
    }
    if (notify.currency && notify.currency !== appointment.currency) {
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

        await tx.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.PAID, paidAt: now },
        });
        await tx.paymentAttempt.updateMany({
          where: { id: attempt.id, status: PaymentStatus.PENDING },
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

function safeJson(raw: string): Prisma.InputJsonValue {
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    return { raw };
  }
}

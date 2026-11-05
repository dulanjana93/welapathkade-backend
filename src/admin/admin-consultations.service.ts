import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AppointmentStatus,
  LedgerEntryKind,
  PaymentStatus,
  Prisma,
  ProposalStatus,
} from '@prisma/client';
import { toMoneyString } from '../common/money/money';
import { normalizePhone } from '../common/phone/normalize-phone';
import { toProposalView } from '../consultations/proposal.mapper';
import { PrismaService } from '../prisma/prisma.service';
import {
  hasDateBound,
  parseUtcHalfOpenRange,
  prismaDateTimeFilter,
} from './admin-finance.date';
import { AdminConsultationsQueryDto } from './dto/admin-consultations.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_CURRENCY = 'LKR';

type ProposalRow = {
  id: string;
  consultationId: string;
  proposedStartAt: Date;
  proposedEndAt: Date;
  durationMinutes: number;
  status: ProposalStatus;
  createdAt: Date;
  updatedAt: Date;
  respondedAt: Date | null;
};

@Injectable()
export class AdminConsultationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Paginated admin consultation list. Read-only: never expires reservations,
   * never marks viewed, never mutates lifecycle.
   */
  async list(query: AdminConsultationsQueryDto) {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = this.buildListWhere(query);

    const [total, rows] = await Promise.all([
      this.prisma.consultation.count({ where }),
      this.prisma.consultation.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          submittedAt: true,
          expiresAt: true,
          respondedAt: true,
          completedAt: true,
          requestedPrice: true,
          serviceNameEn: true,
          serviceNameSi: true,
          customer: {
            select: { id: true, name: true, phone: true },
          },
          astrologer: {
            select: { id: true, displayName: true, userId: true },
          },
        },
      }),
    ]);

    const ids = rows.map((row) => row.id);
    const [proposalRows, appointmentRows] = await Promise.all([
      ids.length === 0
        ? Promise.resolve([] as ProposalRow[])
        : this.prisma.consultationProposal.findMany({
            where: { consultationId: { in: ids } },
            orderBy: [{ createdAt: 'desc' }],
          }),
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.appointment.findMany({
            where: { consultationId: { in: ids } },
            orderBy: [{ createdAt: 'desc' }],
            select: {
              id: true,
              consultationId: true,
              status: true,
              startAt: true,
              reservationExpiresAt: true,
              amount: true,
              currency: true,
              refundObligation: true,
              manualReviewRequired: true,
              createdAt: true,
              payments: {
                select: {
                  id: true,
                  status: true,
                  amount: true,
                  currency: true,
                  paidAt: true,
                  provider: true,
                },
                take: 1,
              },
              financialSnapshot: { select: { id: true } },
            },
          }),
    ]);

    const proposalsByConsultation = groupByConsultationId(proposalRows);
    const latestAppointmentByConsultation = new Map<
      string,
      (typeof appointmentRows)[number]
    >();
    for (const appointment of appointmentRows) {
      if (!latestAppointmentByConsultation.has(appointment.consultationId)) {
        latestAppointmentByConsultation.set(
          appointment.consultationId,
          appointment,
        );
      }
    }

    return {
      page,
      pageSize,
      total,
      notes: {
        appointmentFiltersMatchAnyRelatedAppointment: true,
        listShowsLatestAppointmentByCreatedAt: true,
        readOnly: true,
      },
      items: rows.map((row) => {
        const proposals = proposalsByConsultation.get(row.id) ?? [];
        const proposalSummary = summarizeProposalsForList(proposals);
        const latest = latestAppointmentByConsultation.get(row.id) ?? null;
        const payment = latest?.payments[0] ?? null;
        return {
          id: row.id,
          status: row.status,
          submittedAt: row.submittedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          respondedAt: row.respondedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          requestedPrice: toMoneyString(row.requestedPrice),
          currency: latest?.currency ?? DEFAULT_CURRENCY,
          serviceNameEn: row.serviceNameEn,
          serviceNameSi: row.serviceNameSi,
          customer: row.customer,
          astrologer: {
            id: row.astrologer.id,
            displayName: row.astrologer.displayName,
            userId: row.astrologer.userId,
          },
          proposal: proposalSummary,
          latestAppointment: latest
            ? {
                id: latest.id,
                status: latest.status,
                startAt: latest.startAt.toISOString(),
                reservationExpiresAt:
                  latest.reservationExpiresAt.toISOString(),
                amount: toMoneyString(latest.amount),
                currency: latest.currency,
                refundObligation: latest.refundObligation,
                manualReviewRequired: latest.manualReviewRequired,
                payment: payment
                  ? {
                      id: payment.id,
                      status: payment.status,
                      amount: toMoneyString(payment.amount),
                      currency: payment.currency,
                      paidAt: payment.paidAt?.toISOString() ?? null,
                      provider: payment.provider,
                    }
                  : null,
              }
            : null,
          flags: {
            hasRefundObligation: latest?.refundObligation != null,
            manualReviewRequired: latest?.manualReviewRequired === true,
            hasSnapshot: latest?.financialSnapshot != null,
          },
        };
      }),
    };
  }

  /**
   * Full operational detail for one consultation. Read-only.
   */
  async getById(id: string) {
    const row = await this.prisma.consultation.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        requestedPrice: true,
        serviceNameSi: true,
        serviceNameEn: true,
        serviceId: true,
        astrologerServiceId: true,
        preferredStartAt: true,
        preferredEndAt: true,
        submittedAt: true,
        viewedAt: true,
        respondedAt: true,
        expiresAt: true,
        completedAt: true,
        declineReason: true,
        message: true,
        astrologerSummary: true,
        astrologerSummaryUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            role: true,
            status: true,
          },
        },
        astrologer: {
          select: {
            id: true,
            displayName: true,
            status: true,
            city: true,
            district: true,
            userId: true,
            user: {
              select: {
                id: true,
                name: true,
                phone: true,
                email: true,
                role: true,
                status: true,
              },
            },
          },
        },
        service: {
          select: {
            id: true,
            code: true,
            nameEn: true,
            nameSi: true,
            status: true,
          },
        },
        proposals: {
          orderBy: [{ createdAt: 'desc' }],
        },
        appointments: {
          orderBy: [{ createdAt: 'desc' }],
          select: {
            id: true,
            consultationId: true,
            proposalId: true,
            customerId: true,
            astrologerId: true,
            startAt: true,
            endAt: true,
            durationMinutes: true,
            status: true,
            amount: true,
            currency: true,
            reservationExpiresAt: true,
            confirmedAt: true,
            sessionStartedAt: true,
            sessionEndedAt: true,
            actualDurationSeconds: true,
            cancelledAt: true,
            cancelReason: true,
            noShowRecordedAt: true,
            refundObligation: true,
            refundObligationRecordedAt: true,
            manualReviewRequired: true,
            createdAt: true,
            updatedAt: true,
            payments: {
              take: 1,
              select: {
                id: true,
                status: true,
                provider: true,
                amount: true,
                currency: true,
                paidAt: true,
                createdAt: true,
                updatedAt: true,
                attempts: {
                  orderBy: [{ createdAt: 'desc' }],
                  select: {
                    id: true,
                    merchantReference: true,
                    providerPaymentId: true,
                    status: true,
                    provider: true,
                    requiresReview: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                },
              },
            },
            payHereRefunds: {
              orderBy: [{ createdAt: 'desc' }],
              select: {
                id: true,
                paymentId: true,
                appointmentId: true,
                payherePaymentId: true,
                payhereRefundNumber: true,
                amount: true,
                currency: true,
                status: true,
                reason: true,
                retrySafe: true,
                openRefundSlot: true,
                failureMessage: true,
                providerStatus: true,
                sanitizedResponse: true,
                initiatedAt: true,
                lastReconciledAt: true,
                completedAt: true,
                createdAt: true,
                updatedAt: true,
              },
            },
            financialSnapshot: {
              select: {
                id: true,
                status: true,
                currency: true,
                grossAmount: true,
                basis: true,
                astrologerId: true,
                astrologerPercent: true,
                astrologerAmount: true,
                customerReferrerUserId: true,
                customerReferralPercent: true,
                customerReferralAmount: true,
                astrologerReferrerUserId: true,
                astrologerReferralPercent: true,
                astrologerReferralAmount: true,
                platformPercent: true,
                platformAmount: true,
                completedAt: true,
                holdExpiresAt: true,
                postedAt: true,
                reversedAt: true,
                createdAt: true,
              },
            },
            ledgerEntries: {
              select: {
                id: true,
                category: true,
                kind: true,
                amount: true,
                currency: true,
                userId: true,
                snapshotId: true,
                reversesEntryId: true,
                createdAt: true,
              },
              orderBy: [{ createdAt: 'asc' }],
            },
          },
        },
      },
    });

    if (!row) {
      throw new NotFoundException('Consultation not found');
    }

    const proposalViews = row.proposals.map(toProposalView);
    const pendingProposal =
      proposalViews.find((p) => p.status === ProposalStatus.PENDING) ?? null;
    const acceptedProposal =
      proposalViews.find((p) => p.status === ProposalStatus.ACCEPTED) ?? null;

    return {
      consultation: {
        id: row.id,
        status: row.status,
        requestedPrice: toMoneyString(row.requestedPrice),
        currency: DEFAULT_CURRENCY,
        serviceNameSi: row.serviceNameSi,
        serviceNameEn: row.serviceNameEn,
        serviceId: row.serviceId,
        astrologerServiceId: row.astrologerServiceId,
        preferredStartAt: row.preferredStartAt.toISOString(),
        preferredEndAt: row.preferredEndAt?.toISOString() ?? null,
        submittedAt: row.submittedAt.toISOString(),
        viewedAt: row.viewedAt?.toISOString() ?? null,
        respondedAt: row.respondedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        declineReason: row.declineReason,
        message: row.message,
        astrologerSummary: row.astrologerSummary,
        astrologerSummaryUpdatedAt:
          row.astrologerSummaryUpdatedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      customer: row.customer,
      astrologer: {
        id: row.astrologer.id,
        displayName: row.astrologer.displayName,
        status: row.astrologer.status,
        city: row.astrologer.city,
        district: row.astrologer.district,
        userId: row.astrologer.userId,
        user: row.astrologer.user,
      },
      service: row.service,
      proposals: proposalViews,
      pendingProposal,
      acceptedProposal,
      appointments: row.appointments.map((appointment) => {
        const payment = appointment.payments[0] ?? null;
        const credits = appointment.ledgerEntries.filter(
          (e) => e.kind === LedgerEntryKind.CREDIT,
        );
        const debits = appointment.ledgerEntries.filter(
          (e) => e.kind === LedgerEntryKind.DEBIT,
        );
        const snapshot = appointment.financialSnapshot;
        return {
          id: appointment.id,
          consultationId: appointment.consultationId,
          proposalId: appointment.proposalId,
          customerId: appointment.customerId,
          astrologerId: appointment.astrologerId,
          status: appointment.status,
          startAt: appointment.startAt.toISOString(),
          endAt: appointment.endAt.toISOString(),
          durationMinutes: appointment.durationMinutes,
          amount: toMoneyString(appointment.amount),
          currency: appointment.currency,
          reservationExpiresAt:
            appointment.reservationExpiresAt.toISOString(),
          confirmedAt: appointment.confirmedAt?.toISOString() ?? null,
          sessionStartedAt:
            appointment.sessionStartedAt?.toISOString() ?? null,
          sessionEndedAt: appointment.sessionEndedAt?.toISOString() ?? null,
          actualDurationSeconds: appointment.actualDurationSeconds,
          cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
          cancelReason: appointment.cancelReason,
          noShowRecordedAt:
            appointment.noShowRecordedAt?.toISOString() ?? null,
          refundObligation: appointment.refundObligation,
          refundObligationRecordedAt:
            appointment.refundObligationRecordedAt?.toISOString() ?? null,
          manualReviewRequired: appointment.manualReviewRequired,
          createdAt: appointment.createdAt.toISOString(),
          updatedAt: appointment.updatedAt.toISOString(),
          payment: payment
            ? {
                id: payment.id,
                status: payment.status,
                provider: payment.provider,
                amount: toMoneyString(payment.amount),
                currency: payment.currency,
                paidAt: payment.paidAt?.toISOString() ?? null,
                createdAt: payment.createdAt.toISOString(),
                updatedAt: payment.updatedAt.toISOString(),
                attempts: payment.attempts.map((attempt) => ({
                  id: attempt.id,
                  merchantReference: attempt.merchantReference,
                  providerPaymentId: attempt.providerPaymentId,
                  status: attempt.status,
                  provider: attempt.provider,
                  requiresReview: attempt.requiresReview,
                  createdAt: attempt.createdAt.toISOString(),
                  updatedAt: attempt.updatedAt.toISOString(),
                })),
              }
            : null,
          refunds: appointment.payHereRefunds.map((refund) => ({
            id: refund.id,
            paymentId: refund.paymentId,
            appointmentId: refund.appointmentId,
            payherePaymentId: refund.payherePaymentId,
            payhereRefundNumber: refund.payhereRefundNumber,
            amount: toMoneyString(refund.amount),
            currency: refund.currency,
            status: refund.status,
            reason: refund.reason,
            retrySafe: refund.retrySafe,
            failureMessage: refund.failureMessage,
            providerStatus: refund.providerStatus,
            sanitizedResponse: refund.sanitizedResponse,
            initiatedAt: refund.initiatedAt.toISOString(),
            lastReconciledAt: refund.lastReconciledAt?.toISOString() ?? null,
            completedAt: refund.completedAt?.toISOString() ?? null,
            createdAt: refund.createdAt.toISOString(),
            updatedAt: refund.updatedAt.toISOString(),
          })),
          snapshot: snapshot
            ? {
                id: snapshot.id,
                status: snapshot.status,
                currency: snapshot.currency,
                grossAmount: toMoneyString(snapshot.grossAmount),
                basis: snapshot.basis,
                astrologerId: snapshot.astrologerId,
                astrologerPercent: toMoneyString(snapshot.astrologerPercent),
                astrologerAmount: toMoneyString(snapshot.astrologerAmount),
                customerReferrerUserId: snapshot.customerReferrerUserId,
                customerReferralPercent: toMoneyString(
                  snapshot.customerReferralPercent,
                ),
                customerReferralAmount: toMoneyString(
                  snapshot.customerReferralAmount,
                ),
                astrologerReferrerUserId: snapshot.astrologerReferrerUserId,
                astrologerReferralPercent: toMoneyString(
                  snapshot.astrologerReferralPercent,
                ),
                astrologerReferralAmount: toMoneyString(
                  snapshot.astrologerReferralAmount,
                ),
                platformPercent: toMoneyString(snapshot.platformPercent),
                platformAmount: toMoneyString(snapshot.platformAmount),
                completedAt: snapshot.completedAt.toISOString(),
                holdExpiresAt: snapshot.holdExpiresAt.toISOString(),
                postedAt: snapshot.postedAt?.toISOString() ?? null,
                reversedAt: snapshot.reversedAt?.toISOString() ?? null,
                createdAt: snapshot.createdAt.toISOString(),
              }
            : null,
          ledger: {
            creditCount: credits.length,
            debitCount: debits.length,
            hasCredits: credits.length > 0,
            hasReversals: debits.length > 0,
            entries: appointment.ledgerEntries.map((entry) => ({
              id: entry.id,
              category: entry.category,
              kind: entry.kind,
              amount: toMoneyString(entry.amount),
              currency: entry.currency,
              userId: entry.userId,
              snapshotId: entry.snapshotId,
              reversesEntryId: entry.reversesEntryId,
              createdAt: entry.createdAt.toISOString(),
            })),
          },
        };
      }),
      notes: {
        refundObligationIsNotGatewayRefund: true,
        paymentCaptureDoesNotCreditWallet: true,
        readOnly: true,
      },
    };
  }

  private buildListWhere(
    query: AdminConsultationsQueryDto,
  ): Prisma.ConsultationWhereInput {
    const range = parseUtcHalfOpenRange({ from: query.from, to: query.to });
    const and: Prisma.ConsultationWhereInput[] = [];

    if (query.status) {
      and.push({ status: query.status });
    }
    if (query.customerId) {
      and.push({ customerId: query.customerId });
    }
    if (query.astrologerId) {
      and.push({ astrologerId: query.astrologerId });
    }
    if (hasDateBound(range)) {
      and.push({ submittedAt: prismaDateTimeFilter(range) });
    }

    const search = this.buildSearchWhere(query.q);
    if (search) {
      and.push(search);
    }

    const appointmentFilter = this.buildAppointmentFilter(query);
    if (appointmentFilter) {
      and.push({ appointments: appointmentFilter });
    }

    if (and.length === 0) {
      return {};
    }
    return { AND: and };
  }

  private buildSearchWhere(
    q: string | undefined,
  ): Prisma.ConsultationWhereInput | null {
    if (!q) {
      return null;
    }
    const term = q.trim();
    if (!term) {
      return null;
    }

    const or: Prisma.ConsultationWhereInput[] = [
      { id: term },
      { customer: { name: { contains: term } } },
      { astrologer: { displayName: { contains: term } } },
    ];

    try {
      const phone = normalizePhone(term);
      or.push({ customer: { phone } });
    } catch {
      const digits = term.replace(/[^\d+]/g, '');
      if (digits.length >= 3) {
        or.push({ customer: { phone: { contains: digits } } });
      }
    }

    return { OR: or };
  }

  private buildAppointmentFilter(
    query: AdminConsultationsQueryDto,
  ): Prisma.AppointmentListRelationFilter | null {
    const some: Prisma.AppointmentWhereInput = {};
    const none: Prisma.AppointmentWhereInput = {};
    let useSome = false;
    let useNone = false;

    if (query.appointmentStatus) {
      some.status = query.appointmentStatus as AppointmentStatus;
      useSome = true;
    }
    if (query.paymentStatus) {
      some.payments = {
        some: { status: query.paymentStatus as PaymentStatus },
      };
      useSome = true;
    }

    if (query.hasRefundObligation === true) {
      some.refundObligation = { not: null };
      useSome = true;
    } else if (query.hasRefundObligation === false) {
      none.refundObligation = { not: null };
      useNone = true;
    }

    if (query.manualReviewRequired === true) {
      some.manualReviewRequired = true;
      useSome = true;
    } else if (query.manualReviewRequired === false) {
      none.manualReviewRequired = true;
      useNone = true;
    }

    if (!useSome && !useNone) {
      return null;
    }

    const filter: Prisma.AppointmentListRelationFilter = {};
    if (useSome) {
      filter.some = some;
    }
    if (useNone) {
      filter.none = none;
    }
    return filter;
  }
}

function groupByConsultationId<T extends { consultationId: string }>(
  rows: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.consultationId) ?? [];
    list.push(row);
    map.set(row.consultationId, list);
  }
  return map;
}

function summarizeProposalsForList(proposals: ProposalRow[]) {
  const views = proposals.map(toProposalView);
  const pending =
    views.find((p) => p.status === ProposalStatus.PENDING) ?? null;
  const accepted =
    views.find((p) => p.status === ProposalStatus.ACCEPTED) ?? null;
  return {
    pendingProposal: pending
      ? {
          id: pending.id,
          status: pending.status,
          proposedStartAt: pending.proposedStartAt,
          durationMinutes: pending.durationMinutes,
        }
      : null,
    acceptedProposal: accepted
      ? {
          id: accepted.id,
          status: accepted.status,
          proposedStartAt: accepted.proposedStartAt,
          durationMinutes: accepted.durationMinutes,
        }
      : null,
    totalCount: views.length,
  };
}

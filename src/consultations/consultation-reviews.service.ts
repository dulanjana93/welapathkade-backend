import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  Prisma,
  UserRole,
  type User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  REVIEW_LIST_DEFAULT_LIMIT,
  REVIEW_LIST_MAX_LIMIT,
} from './consultation-review.constants';
import {
  evaluateReviewEligibility,
  normalizeReviewBody,
  publicReviewAuthorLabel,
} from './consultation-review.eligibility';

export type OwnReviewView = {
  id: string;
  consultationId: string;
  rating: number;
  body: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicReviewView = {
  id: string;
  rating: number;
  body: string | null;
  authorLabel: string;
  createdAt: string;
};

export type RatingSummaryView = {
  /** Null when reviewCount is 0 — never a fabricated average. */
  averageRating: number | null;
  reviewCount: number;
};

export type ReviewDetailExtras = {
  myReview: OwnReviewView | null;
  canSubmitReview: boolean;
  canEditReview: boolean;
};

@Injectable()
export class ConsultationReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnForCustomer(
    user: User,
    consultationId: string,
  ): Promise<OwnReviewView | null> {
    this.requireCustomer(user);
    const consultation = await this.requireOwnedConsultation(
      user.id,
      consultationId,
    );
    const row = await this.prisma.consultationReview.findUnique({
      where: { consultationId: consultation.id },
    });
    return row ? this.toOwnView(row) : null;
  }

  async createForCustomer(
    user: User,
    consultationId: string,
    rating: number,
    rawBody: string | undefined,
  ): Promise<OwnReviewView> {
    this.requireCustomer(user);
    const ctx = await this.loadWritableContext(user.id, consultationId);
    this.assertEligible(ctx);

    const existing = await this.prisma.consultationReview.findUnique({
      where: { consultationId },
    });
    if (existing) {
      throw new ConflictException('A review already exists for this consultation');
    }

    const body = normalizeReviewBody(rawBody);
    try {
      const created = await this.prisma.consultationReview.create({
        data: {
          consultationId: ctx.consultation.id,
          customerId: user.id,
          astrologerId: ctx.consultation.astrologerId,
          rating,
          body,
        },
      });
      return this.toOwnView(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A review already exists for this consultation',
        );
      }
      throw err;
    }
  }

  async updateForCustomer(
    user: User,
    consultationId: string,
    rating: number,
    rawBody: string | undefined,
  ): Promise<OwnReviewView> {
    this.requireCustomer(user);
    const ctx = await this.loadWritableContext(user.id, consultationId);
    this.assertEligible(ctx);

    const existing = await this.prisma.consultationReview.findUnique({
      where: { consultationId },
    });
    if (!existing || existing.customerId !== user.id) {
      throw new NotFoundException('Review not found');
    }

    const updated = await this.prisma.consultationReview.update({
      where: { id: existing.id },
      data: {
        rating,
        body: normalizeReviewBody(rawBody),
      },
    });
    return this.toOwnView(updated);
  }

  async buildDetailExtras(
    consultationId: string,
    customerId: string,
    appointment: {
      status: string;
      refundObligation?: string | null;
      payment?: { status: string } | null;
    } | null,
    consultationStatus: ConsultationStatus,
  ): Promise<ReviewDetailExtras> {
    const eligibility = evaluateReviewEligibility({
      consultationStatus,
      appointmentStatus: appointment?.status ?? null,
      refundObligation: appointment?.refundObligation ?? null,
      paymentStatus: appointment?.payment?.status ?? PaymentStatus.PAID,
    });
    const row = await this.prisma.consultationReview.findUnique({
      where: { consultationId },
    });
    const myReview =
      row && row.customerId === customerId ? this.toOwnView(row) : null;
    return {
      myReview,
      canSubmitReview: eligibility.eligible && myReview == null,
      canEditReview: eligibility.eligible && myReview != null,
    };
  }

  async listPublicForAstrologer(
    astrologerId: string,
    page = 1,
    limit = REVIEW_LIST_DEFAULT_LIMIT,
  ): Promise<{
    items: PublicReviewView[];
    page: number;
    limit: number;
    total: number;
    summary: RatingSummaryView;
  }> {
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { id: astrologerId },
      select: { id: true },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer not found');
    }

    const safeLimit = Math.min(
      REVIEW_LIST_MAX_LIMIT,
      Math.max(1, limit || REVIEW_LIST_DEFAULT_LIMIT),
    );
    const safePage = Math.max(1, page || 1);
    const skip = (safePage - 1) * safeLimit;

    const eligibleWhere = this.eligibleReviewWhere(astrologerId);

    const [total, rows, summary] = await Promise.all([
      this.prisma.consultationReview.count({ where: eligibleWhere }),
      this.prisma.consultationReview.findMany({
        where: eligibleWhere,
        include: { customer: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.aggregateForAstrologer(astrologerId),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        authorLabel: publicReviewAuthorLabel(r.customer.name),
        createdAt: r.createdAt.toISOString(),
      })),
      page: safePage,
      limit: safeLimit,
      total,
      summary,
    };
  }

  async aggregateForAstrologer(astrologerId: string): Promise<RatingSummaryView> {
    const map = await this.aggregateForAstrologers([astrologerId]);
    return map.get(astrologerId) ?? { averageRating: null, reviewCount: 0 };
  }

  /**
   * Bulk average + count for discovery cards. One grouped query for all ids.
   * Ineligible (refunded / non-completed) reviews are excluded via join filters.
   */
  async aggregateForAstrologers(
    astrologerIds: string[],
  ): Promise<Map<string, RatingSummaryView>> {
    const result = new Map<string, RatingSummaryView>();
    for (const id of astrologerIds) {
      result.set(id, { averageRating: null, reviewCount: 0 });
    }
    if (astrologerIds.length === 0) return result;

    const grouped = await this.prisma.consultationReview.groupBy({
      by: ['astrologerId'],
      where: {
        astrologerId: { in: astrologerIds },
        consultation: {
          status: ConsultationStatus.COMPLETED,
          appointments: {
            some: {
              status: AppointmentStatus.COMPLETED,
              refundObligation: null,
            },
          },
        },
      },
      _avg: { rating: true },
      _count: { _all: true },
    });

    for (const row of grouped) {
      const count = row._count._all;
      const avg = row._avg.rating;
      result.set(row.astrologerId, {
        reviewCount: count,
        averageRating:
          count > 0 && avg != null ? Number(avg) : null,
      });
    }
    return result;
  }

  private eligibleReviewWhere(astrologerId: string): Prisma.ConsultationReviewWhereInput {
    return {
      astrologerId,
      consultation: {
        status: ConsultationStatus.COMPLETED,
        appointments: {
          some: {
            status: AppointmentStatus.COMPLETED,
            refundObligation: null,
          },
        },
      },
    };
  }

  private async loadWritableContext(customerId: string, consultationId: string) {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        appointments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            payments: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    });
    if (!consultation || consultation.customerId !== customerId) {
      throw new NotFoundException('Consultation not found');
    }
    const appointment = consultation.appointments[0] ?? null;
    return { consultation, appointment };
  }

  private assertEligible(ctx: {
    consultation: { status: ConsultationStatus };
    appointment: {
      status: AppointmentStatus;
      refundObligation: string | null;
      payments: Array<{ status: PaymentStatus }>;
    } | null;
  }) {
    const paymentStatus = ctx.appointment?.payments[0]?.status ?? null;
    const result = evaluateReviewEligibility({
      consultationStatus: ctx.consultation.status,
      appointmentStatus: ctx.appointment?.status ?? null,
      refundObligation: ctx.appointment?.refundObligation ?? null,
      paymentStatus,
    });
    if (!result.eligible) {
      throw new ConflictException(
        `Consultation is not eligible for review (${result.reason})`,
      );
    }
  }

  private async requireOwnedConsultation(
    customerId: string,
    consultationId: string,
  ) {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { id: true, customerId: true },
    });
    if (!consultation || consultation.customerId !== customerId) {
      throw new NotFoundException('Consultation not found');
    }
    return consultation;
  }

  private requireCustomer(user: User) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
  }

  private toOwnView(row: {
    id: string;
    consultationId: string;
    rating: number;
    body: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): OwnReviewView {
    return {
      id: row.id,
      consultationId: row.consultationId,
      rating: row.rating,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

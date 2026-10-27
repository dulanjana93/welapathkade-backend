import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  ConsultationStatus,
  FileStatus,
  Prisma,
  ServiceStatus,
  User,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AvailabilityService } from '../availability/availability.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { attachmentLimitsFromEnv } from './attachment-limits';
import { assertAttachmentsLinkable } from './attachment-validation';
import { isAttachmentUniqueConflict } from './consultation-attachments.service';
import {
  CONSULTATION_IDEMPOTENCY_CONFLICT,
  consultationRequestFingerprint,
  isPrismaUniqueConflict,
} from './consultation-idempotency';
import { CONSULTATION_RESPONSE_TIMEOUT_HOURS } from './consultation.constants';
import { expirePendingConsultations } from './consultation-expiry';
import {
  toAstrologerDetail,
  toAstrologerListEntry,
  toCustomerDetail,
  toCustomerListEntry,
} from './consultation.mapper';
import { canAstrologerRespond, canCustomerCancel } from './consultation.state';
import {
  CreateConsultationDto,
  DeclineConsultationDto,
} from './dto/consultation.dto';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationFollowUpService } from './consultation-follow-up.service';
import { ConsultationReviewsService } from './consultation-reviews.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly proposals: ConsultationProposalsService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationService,
    private readonly followUp: ConsultationFollowUpService,
    private readonly reviews: ConsultationReviewsService,
  ) {}

  async create(
    user: User,
    dto: CreateConsultationDto,
    idempotencyKey: string | null = null,
  ) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException(
        'Only PUBLIC customers can create consultations',
      );
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Account is not active');
    }

    const preferredStartAt = new Date(dto.preferredStartAt);
    const preferredEndAt = dto.preferredEndAt
      ? new Date(dto.preferredEndAt)
      : null;
    const message = dto.message?.trim() || null;
    const fileAttachments = dto.files ?? [];
    const fingerprint = idempotencyKey
      ? consultationRequestFingerprint({
          astrologerId: dto.astrologerId,
          serviceId: dto.serviceId,
          preferredStartAt,
          preferredEndAt,
          message,
          files: fileAttachments,
        })
      : null;

    if (idempotencyKey && fingerprint) {
      const replay = await this.lookupIdempotentSubmission(
        this.prisma,
        user.id,
        idempotencyKey,
        fingerprint,
      );
      if (replay) {
        return this.getForCustomer(user, replay.id);
      }
    }

    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { id: dto.astrologerId },
      include: { user: true },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer not found');
    }
    if (profile.status === AstrologerProfileStatus.SUSPENDED) {
      throw new BadRequestException('Astrologer is suspended');
    }
    if (profile.status !== AstrologerProfileStatus.ACTIVE) {
      throw new BadRequestException('Astrologer is not active');
    }
    if (profile.user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Astrologer is not available');
    }
    if (!profile.isOnline) {
      throw new BadRequestException(
        'Astrologer is offline and not accepting new requests',
      );
    }

    const platformService = await this.prisma.service.findUnique({
      where: { id: dto.serviceId },
    });
    if (!platformService) {
      throw new NotFoundException('Service not found');
    }
    if (platformService.status !== ServiceStatus.ACTIVE) {
      throw new BadRequestException('Service is not active');
    }

    const astrologerService = await this.prisma.astrologerService.findUnique({
      where: {
        astrologerId_serviceId: {
          astrologerId: profile.id,
          serviceId: platformService.id,
        },
      },
    });
    if (!astrologerService) {
      throw new BadRequestException('Astrologer does not offer this service');
    }
    if (astrologerService.status !== AstrologerServiceStatus.ACTIVE) {
      throw new BadRequestException('Astrologer service is not active');
    }

    // Eligibility only — does not reserve or lock the slot.
    await this.availability.assertPreferredSlotEligible({
      astrologerId: profile.id,
      preferredStartAt,
      preferredEndAt,
    });

    const submittedAt = new Date();
    const expiresAt = new Date(
      submittedAt.getTime() +
        CONSULTATION_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    let created: {
      consultation: { id: string };
      notificationId: string | null;
    };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        if (idempotencyKey && fingerprint) {
          const replay = await this.lookupIdempotentSubmission(
            tx,
            user.id,
            idempotencyKey,
            fingerprint,
          );
          if (replay) {
            return { consultation: replay, notificationId: null };
          }
        }

        const consultation = await tx.consultation.create({
          data: {
            customerId: user.id,
            astrologerId: profile.id,
            astrologerServiceId: astrologerService.id,
            serviceId: platformService.id,
            requestedPrice: astrologerService.price,
            serviceNameSi: platformService.nameSi,
            serviceNameEn: platformService.nameEn,
            message,
            status: ConsultationStatus.PENDING,
            preferredStartAt,
            preferredEndAt,
            submittedAt,
            expiresAt,
            viewedAt: null,
            respondedAt: null,
            clientIdempotencyKey: idempotencyKey,
            requestFingerprint: fingerprint,
          },
        });

        if (fileAttachments.length > 0) {
          const fileIds = fileAttachments.map((f) => f.fileId);
          const files = await tx.file.findMany({
            where: {
              id: { in: fileIds },
              uploadedByUserId: user.id,
              status: FileStatus.AVAILABLE,
            },
            include: { consultationFiles: { select: { id: true } } },
          });
          assertAttachmentsLinkable(
            files.map((file) => ({
              id: file.id,
              mimeType: file.mimeType,
              linked: file.consultationFiles.length > 0,
            })),
            fileAttachments,
            attachmentLimitsFromEnv(),
          );
          try {
            await tx.consultationFile.createMany({
              data: fileAttachments.map((f, index) => ({
                consultationId: consultation.id,
                fileId: f.fileId,
                type: f.type,
                sortOrder: index,
              })),
            });
          } catch (error) {
            if (isAttachmentUniqueConflict(error)) {
              throw new BadRequestException(
                'One or more files are already attached to a request',
              );
            }
            throw error;
          }
        }

        // Same transaction as the consultation row: both commit or neither.
        const notificationId = await this.notifications.notifyUser(
          tx,
          profile.userId,
          { type: 'CONSULTATION_REQUESTED', consultationId: consultation.id },
          profile.user.language,
        );

        return { consultation, notificationId };
      });
    } catch (error) {
      if (idempotencyKey && fingerprint && isPrismaUniqueConflict(error)) {
        const replay = await this.lookupIdempotentSubmission(
          this.prisma,
          user.id,
          idempotencyKey,
          fingerprint,
        );
        if (replay) {
          return this.getForCustomer(user, replay.id);
        }
      }
      throw error;
    }

    // Committed: only now start (non-blocking) delivery. Replays skip this.
    if (created.notificationId) {
      this.notifications.deliverAfterCommit([created.notificationId]);
    }

    return this.getForCustomer(user, created.consultation.id);
  }

  async listForCustomer(user: User, status?: ConsultationStatus) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    await this.expireDuePendingForCustomer(user.id);

    const rows = await this.prisma.consultation.findMany({
      where: {
        customerId: user.id,
        ...(status ? { status } : {}),
      },
      include: {
        astrologer: { select: { id: true, displayName: true } },
      },
      orderBy: [{ submittedAt: 'desc' }],
    });
    const lifecycle = await this.loadListLifecycle(rows.map((r) => r.id));
    return rows.map((r) => toCustomerListEntry(r, lifecycle.get(r.id)));
  }

  async listForAstrologer(user: User, status?: ConsultationStatus) {
    const profile = await this.requireAstrologerProfile(user);
    await this.expireDuePendingForAstrologer(profile.id);

    const rows = await this.prisma.consultation.findMany({
      where: {
        astrologerId: profile.id,
        ...(status ? { status } : {}),
      },
      include: {
        customer: { select: { id: true, name: true } },
      },
      orderBy: [{ submittedAt: 'desc' }],
    });
    const lifecycle = await this.loadListLifecycle(rows.map((r) => r.id));
    return rows.map((r) => toAstrologerListEntry(r, lifecycle.get(r.id)));
  }

  /**
   * Proposal + latest-appointment facts for list rows, in two bulk queries.
   * The caller has already scoped `ids` to the viewer's own consultations.
   */
  private async loadListLifecycle(ids: string[]) {
    const [summaries, appointments] = await Promise.all([
      this.proposals.loadProposalSummaries(ids),
      this.payments.listLatestAppointmentViews(ids),
    ]);
    return new Map(
      ids.map((id) => {
        const summary = summaries.get(id);
        return [
          id,
          {
            pendingProposal: summary?.pendingProposal ?? null,
            acceptedProposal: summary?.acceptedProposal ?? null,
            appointment: appointments.get(id) ?? null,
          },
        ] as const;
      }),
    );
  }

  async getForCustomer(user: User, id: string) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const row = await this.loadAndExpire(id);
    if (!row || row.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }
    const full = await this.prisma.consultation.findUniqueOrThrow({
      where: { id },
      include: {
        astrologer: { select: { id: true, displayName: true } },
        files: { include: { file: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    const proposalSummary = await this.proposals.loadProposalSummary(id);
    const appointment = await this.payments.getSummaryForCustomer(id);
    const followUp = await this.followUp.buildFollowUpView({
      consultationId: id,
      customerId: full.customerId,
      consultationStatus: full.status,
      appointmentStatus: appointment?.status ?? null,
      completedAt: full.completedAt,
      viewerIsCustomer: true,
    });
    const reviewExtras = await this.reviews.buildDetailExtras(
      id,
      full.customerId,
      appointment,
      full.status,
    );
    return toCustomerDetail(full, proposalSummary, appointment, {
      followUp,
      myReview: reviewExtras.myReview,
      canSubmitReview: reviewExtras.canSubmitReview,
      canEditReview: reviewExtras.canEditReview,
    });
  }

  async getForAstrologer(user: User, id: string, markViewed = true) {
    const profile = await this.requireAstrologerProfile(user);
    const row = await this.loadAndExpire(id);
    if (!row || row.astrologerId !== profile.id) {
      throw new NotFoundException('Consultation not found');
    }

    if (
      markViewed &&
      row.status === ConsultationStatus.PENDING &&
      row.viewedAt == null
    ) {
      await this.prisma.consultation.updateMany({
        where: {
          id: row.id,
          status: ConsultationStatus.PENDING,
          viewedAt: null,
        },
        data: { viewedAt: new Date() },
      });
    }

    const full = await this.prisma.consultation.findUniqueOrThrow({
      where: { id },
      include: {
        customer: { select: { id: true, name: true } },
        files: { include: { file: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    const proposalSummary = await this.proposals.loadProposalSummary(id);
    const appointment = await this.payments.getSummaryForAstrologer(id);
    const followUp = await this.followUp.buildFollowUpView({
      consultationId: id,
      customerId: full.customerId,
      consultationStatus: full.status,
      appointmentStatus: appointment?.status ?? null,
      completedAt: full.completedAt,
      viewerIsCustomer: false,
    });
    return toAstrologerDetail(full, proposalSummary, appointment, { followUp });
  }

  /** Shared detail for customer owner or assigned astrologer. */
  async getByIdForActor(user: User, id: string) {
    if (user.role === UserRole.PUBLIC) {
      return this.getForCustomer(user, id);
    }
    if (user.role === UserRole.ASTROLOGER) {
      return this.getForAstrologer(user, id, true);
    }
    throw new ForbiddenException('Not authorized to view this consultation');
  }

  async accept(user: User, id: string) {
    const profile = await this.requireAstrologerProfile(user);
    const row = await this.loadAndExpire(id);
    if (!row || row.astrologerId !== profile.id) {
      throw new NotFoundException('Consultation not found');
    }

    if (row.status === ConsultationStatus.EXPIRED) {
      throw new ConflictException('Consultation has expired');
    }
    if (!canAstrologerRespond(row.status)) {
      throw new ConflictException(
        `Cannot accept consultation in status ${row.status}`,
      );
    }

    const now = new Date();
    if (row.expiresAt <= now) {
      await this.expireIfDue(row.id, now);
      throw new ConflictException('Consultation has expired');
    }

    // State change and notification row commit atomically.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.consultation.updateMany({
        where: {
          id: row.id,
          astrologerId: profile.id,
          status: ConsultationStatus.PENDING,
          expiresAt: { gt: now },
        },
        data: {
          status: ConsultationStatus.ACCEPTED,
          respondedAt: now,
        },
      });
      if (updated.count !== 1) return null;
      const notificationId = await this.notifications.notifyUser(
        tx,
        row.customerId,
        { type: 'CONSULTATION_ACCEPTED', consultationId: row.id },
      );
      return { notificationId };
    });
    if (!outcome) {
      const current = await this.loadAndExpire(id);
      if (current?.status === ConsultationStatus.EXPIRED) {
        throw new ConflictException('Consultation has expired');
      }
      throw new ConflictException('Consultation could not be accepted');
    }
    this.notifications.deliverAfterCommit([outcome.notificationId]);

    return this.getForAstrologer(user, id, false);
  }

  async decline(user: User, id: string, dto: DeclineConsultationDto) {
    const profile = await this.requireAstrologerProfile(user);
    const row = await this.loadAndExpire(id);
    if (!row || row.astrologerId !== profile.id) {
      throw new NotFoundException('Consultation not found');
    }

    if (row.status === ConsultationStatus.EXPIRED) {
      throw new ConflictException('Consultation has expired');
    }
    if (!canAstrologerRespond(row.status)) {
      throw new ConflictException(
        `Cannot decline consultation in status ${row.status}`,
      );
    }

    const now = new Date();
    if (row.expiresAt <= now) {
      await this.expireIfDue(row.id, now);
      throw new ConflictException('Consultation has expired');
    }

    // State change and notification row commit atomically. The decline
    // reason is stored on the consultation only; it is never in the
    // notification.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.consultation.updateMany({
        where: {
          id: row.id,
          astrologerId: profile.id,
          status: ConsultationStatus.PENDING,
          expiresAt: { gt: now },
        },
        data: {
          status: ConsultationStatus.DECLINED,
          respondedAt: now,
          declineReason: dto.reason?.trim() || null,
        },
      });
      if (updated.count !== 1) return null;
      const notificationId = await this.notifications.notifyUser(
        tx,
        row.customerId,
        { type: 'CONSULTATION_DECLINED', consultationId: row.id },
      );
      return { notificationId };
    });
    if (!outcome) {
      const current = await this.loadAndExpire(id);
      if (current?.status === ConsultationStatus.EXPIRED) {
        throw new ConflictException('Consultation has expired');
      }
      throw new ConflictException('Consultation could not be declined');
    }
    this.notifications.deliverAfterCommit([outcome.notificationId]);

    return this.getForAstrologer(user, id, false);
  }

  async cancel(user: User, id: string) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const row = await this.loadAndExpire(id);
    if (!row || row.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }
    if (!canCustomerCancel(row.status)) {
      throw new ConflictException(
        `Cannot cancel consultation in status ${row.status}`,
      );
    }

    const updated = await this.prisma.consultation.updateMany({
      where: {
        id: row.id,
        customerId: user.id,
        status: ConsultationStatus.PENDING,
      },
      data: {
        status: ConsultationStatus.CANCELLED,
        respondedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw new ConflictException('Consultation could not be cancelled');
    }

    return this.getForCustomer(user, id);
  }

  private async requireAstrologerProfile(user: User) {
    if (user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException('Astrologer role required');
    }
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }
    return profile;
  }

  private async lookupIdempotentSubmission(
    db: Prisma.TransactionClient | PrismaService,
    customerId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<{ id: string } | null> {
    const existing = await db.consultation.findUnique({
      where: {
        customerId_clientIdempotencyKey: {
          customerId,
          clientIdempotencyKey: idempotencyKey,
        },
      },
      select: { id: true, requestFingerprint: true },
    });
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint) {
      throw new ConflictException(CONSULTATION_IDEMPOTENCY_CONFLICT);
    }
    return { id: existing.id };
  }

  private async loadAndExpire(id: string) {
    const row = await this.prisma.consultation.findUnique({ where: { id } });
    if (!row) return null;
    if (
      row.status === ConsultationStatus.PENDING &&
      row.expiresAt <= new Date()
    ) {
      await this.expireIfDue(row.id);
      return this.prisma.consultation.findUnique({ where: { id } });
    }
    return row;
  }

  /** Idempotent PENDING → EXPIRED when expiresAt <= now. */
  private async expireIfDue(id: string, now: Date = new Date()) {
    await expirePendingConsultations(this.prisma, now, { id });
  }

  private async expireDuePendingForCustomer(customerId: string) {
    await expirePendingConsultations(this.prisma, new Date(), { customerId });
  }

  private async expireDuePendingForAstrologer(astrologerId: string) {
    await expirePendingConsultations(this.prisma, new Date(), {
      astrologerId,
    });
  }
}

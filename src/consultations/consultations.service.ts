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
  ServiceStatus,
  User,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AvailabilityService } from '../availability/availability.service';
import { PrismaService } from '../prisma/prisma.service';
import { CONSULTATION_RESPONSE_TIMEOUT_HOURS } from './consultation.constants';
import {
  toAstrologerDetail,
  toAstrologerListItem,
  toCustomerDetail,
  toCustomerListItem,
} from './consultation.mapper';
import {
  canAstrologerRespond,
  canCustomerCancel,
} from './consultation.state';
import {
  CreateConsultationDto,
  DeclineConsultationDto,
} from './dto/consultation.dto';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly proposals: ConsultationProposalsService,
    private readonly payments: PaymentsService,
  ) {}

  async create(user: User, dto: CreateConsultationDto) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('Only PUBLIC customers can create consultations');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Account is not active');
    }

    const preferredStartAt = new Date(dto.preferredStartAt);
    const preferredEndAt = dto.preferredEndAt
      ? new Date(dto.preferredEndAt)
      : null;

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

    const fileAttachments = dto.files ?? [];
    if (fileAttachments.length > 0) {
      const fileIds = fileAttachments.map((f) => f.fileId);
      const uniqueIds = new Set(fileIds);
      if (uniqueIds.size !== fileIds.length) {
        throw new BadRequestException('Duplicate file attachments');
      }
      const files = await this.prisma.file.findMany({
        where: {
          id: { in: fileIds },
          uploadedByUserId: user.id,
          status: { in: [FileStatus.AVAILABLE, FileStatus.UPLOADING] },
        },
      });
      if (files.length !== fileIds.length) {
        throw new BadRequestException(
          'One or more files are missing or not owned by you',
        );
      }
    }

    const submittedAt = new Date();
    const expiresAt = new Date(
      submittedAt.getTime() +
        CONSULTATION_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const consultation = await tx.consultation.create({
        data: {
          customerId: user.id,
          astrologerId: profile.id,
          astrologerServiceId: astrologerService.id,
          serviceId: platformService.id,
          requestedPrice: astrologerService.price,
          serviceNameSi: platformService.nameSi,
          serviceNameEn: platformService.nameEn,
          message: dto.message?.trim() || null,
          status: ConsultationStatus.PENDING,
          preferredStartAt,
          preferredEndAt,
          submittedAt,
          expiresAt,
          viewedAt: null,
          respondedAt: null,
        },
      });

      if (fileAttachments.length > 0) {
        await tx.consultationFile.createMany({
          data: fileAttachments.map((f, index) => ({
            consultationId: consultation.id,
            fileId: f.fileId,
            type: f.type,
            sortOrder: index,
          })),
        });
      }

      return consultation;
    });

    return this.getForCustomer(user, created.id);
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
    return rows.map(toCustomerListItem);
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
    return rows.map(toAstrologerListItem);
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
    const appointment = await this.payments.getSummaryForConsultation(id);
    return toCustomerDetail(full, proposalSummary, appointment);
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
    const appointment = await this.payments.getSummaryForConsultation(id);
    return toAstrologerDetail(full, proposalSummary, appointment);
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

    const updated = await this.prisma.consultation.updateMany({
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
    if (updated.count === 0) {
      const current = await this.loadAndExpire(id);
      if (current?.status === ConsultationStatus.EXPIRED) {
        throw new ConflictException('Consultation has expired');
      }
      throw new ConflictException('Consultation could not be accepted');
    }

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

    const updated = await this.prisma.consultation.updateMany({
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
    if (updated.count === 0) {
      const current = await this.loadAndExpire(id);
      if (current?.status === ConsultationStatus.EXPIRED) {
        throw new ConflictException('Consultation has expired');
      }
      throw new ConflictException('Consultation could not be declined');
    }

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
    await this.prisma.consultation.updateMany({
      where: {
        id,
        status: ConsultationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ConsultationStatus.EXPIRED },
    });
  }

  private async expireDuePendingForCustomer(customerId: string) {
    const now = new Date();
    await this.prisma.consultation.updateMany({
      where: {
        customerId,
        status: ConsultationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ConsultationStatus.EXPIRED },
    });
  }

  private async expireDuePendingForAstrologer(astrologerId: string) {
    const now = new Date();
    await this.prisma.consultation.updateMany({
      where: {
        astrologerId,
        status: ConsultationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ConsultationStatus.EXPIRED },
    });
  }
}

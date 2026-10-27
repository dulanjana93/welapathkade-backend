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
  ServiceStatus,
  UserRole,
  UserStatus,
  type User,
} from '@prisma/client';
import { toMoneyString } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import {
  FOLLOW_UP_CUSTOMER_MESSAGE_LIMIT,
  FOLLOW_UP_MESSAGE_MAX_LENGTH,
} from './consultation-follow-up.constants';
import {
  deriveFollowUpMessaging,
  isFollowUpWindowOpen,
  isSuccessfullyCompleted,
  normalizeMessageBody,
  normalizeSummaryText,
  type FollowUpMessagingView,
} from './consultation-follow-up';

export type FollowUpMessageView = {
  id: string;
  consultationId: string;
  senderUserId: string;
  /** CUSTOMER | ASTROLOGER — derived from consultation participants. */
  senderRole: 'CUSTOMER' | 'ASTROLOGER';
  body: string;
  createdAt: string;
};

export type BookAgainView = {
  eligible: boolean;
  reason: string | null;
  sourceConsultationId: string;
  astrologerId: string | null;
  astrologerDisplayName: string | null;
  serviceId: string | null;
  serviceNameSi: string | null;
  serviceNameEn: string | null;
  /** Current live price when eligible; never the historical snapshot alone. */
  requestedPrice: string | null;
};

@Injectable()
export class ConsultationFollowUpService {
  constructor(private readonly prisma: PrismaService) {}

  async countCustomerMessages(consultationId: string, customerId: string) {
    return this.prisma.consultationFollowUpMessage.count({
      where: { consultationId, senderUserId: customerId },
    });
  }

  async buildFollowUpView(input: {
    consultationId: string;
    customerId: string;
    consultationStatus: ConsultationStatus;
    appointmentStatus?: string | null;
    completedAt: Date | null;
    viewerIsCustomer: boolean;
    now?: Date;
  }): Promise<FollowUpMessagingView> {
    const sent = await this.countCustomerMessages(
      input.consultationId,
      input.customerId,
    );
    return deriveFollowUpMessaging({
      consultationStatus: input.consultationStatus,
      appointmentStatus: input.appointmentStatus,
      completedAt: input.completedAt,
      customerMessagesSent: sent,
      viewerIsCustomer: input.viewerIsCustomer,
      now: input.now,
    });
  }

  async listForCustomer(user: User, consultationId: string) {
    const row = await this.requireCustomerParticipant(user, consultationId);
    this.assertMessagingReadable(row);
    return this.listMessages(row.id, row.customerId, row.astrologer.userId);
  }

  async listForAstrologer(user: User, consultationId: string) {
    const row = await this.requireAstrologerParticipant(user, consultationId);
    this.assertMessagingReadable(row);
    return this.listMessages(row.id, row.customerId, row.astrologer.userId);
  }

  async sendForCustomer(user: User, consultationId: string, rawBody: string) {
    const row = await this.requireCustomerParticipant(user, consultationId);
    return this.sendMessage({
      consultation: row,
      senderUserId: user.id,
      senderIsCustomer: true,
      rawBody,
    });
  }

  async sendForAstrologer(user: User, consultationId: string, rawBody: string) {
    const row = await this.requireAstrologerParticipant(user, consultationId);
    return this.sendMessage({
      consultation: row,
      senderUserId: user.id,
      senderIsCustomer: false,
      rawBody,
    });
  }

  async upsertSummaryForAstrologer(
    user: User,
    consultationId: string,
    rawSummary: string | undefined,
  ) {
    const row = await this.requireAstrologerParticipant(user, consultationId);
    if (
      !isSuccessfullyCompleted({
        consultationStatus: row.status,
        appointmentStatus: row.appointments[0]?.status ?? null,
      })
    ) {
      throw new ConflictException(
        'Summary can only be saved for a completed consultation',
      );
    }

    const summary = normalizeSummaryText(rawSummary);
    const updated = await this.prisma.consultation.update({
      where: { id: row.id },
      data: {
        astrologerSummary: summary,
        astrologerSummaryUpdatedAt: new Date(),
      },
      select: {
        id: true,
        astrologerSummary: true,
        astrologerSummaryUpdatedAt: true,
      },
    });

    return {
      id: updated.id,
      astrologerSummary: updated.astrologerSummary,
      astrologerSummaryUpdatedAt: updated.astrologerSummaryUpdatedAt
        ? updated.astrologerSummaryUpdatedAt.toISOString()
        : null,
    };
  }

  async bookAgainForCustomer(
    user: User,
    consultationId: string,
  ): Promise<BookAgainView> {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const row = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        astrologer: { include: { user: true } },
        appointments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
        service: true,
        astrologerService: true,
      },
    });
    if (!row || row.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }

    const base: BookAgainView = {
      eligible: false,
      reason: null,
      sourceConsultationId: row.id,
      astrologerId: row.astrologerId,
      astrologerDisplayName: row.astrologer.displayName,
      serviceId: row.serviceId,
      serviceNameSi: row.serviceNameSi,
      serviceNameEn: row.serviceNameEn,
      requestedPrice: null,
    };

    if (
      !isSuccessfullyCompleted({
        consultationStatus: row.status,
        appointmentStatus: row.appointments[0]?.status ?? null,
      })
    ) {
      return { ...base, reason: 'Consultation is not completed' };
    }

    if (row.astrologer.status === AstrologerProfileStatus.SUSPENDED) {
      return { ...base, reason: 'Astrologer is suspended' };
    }
    if (row.astrologer.status !== AstrologerProfileStatus.ACTIVE) {
      return { ...base, reason: 'Astrologer is not active' };
    }
    if (row.astrologer.user.status !== UserStatus.ACTIVE) {
      return { ...base, reason: 'Astrologer is not available' };
    }
    if (!row.astrologer.isOnline) {
      return {
        ...base,
        reason: 'Astrologer is offline and not accepting new requests',
      };
    }
    if (row.service.status !== ServiceStatus.ACTIVE) {
      return { ...base, reason: 'Service is not active' };
    }
    if (row.astrologerService.status !== AstrologerServiceStatus.ACTIVE) {
      return { ...base, reason: 'Astrologer service is not active' };
    }

    return {
      ...base,
      eligible: true,
      reason: null,
      requestedPrice: toMoneyString(row.astrologerService.price),
      serviceNameSi: row.service.nameSi,
      serviceNameEn: row.service.nameEn,
    };
  }

  private async listMessages(
    consultationId: string,
    customerId: string,
    astrologerUserId: string,
  ): Promise<FollowUpMessageView[]> {
    const rows = await this.prisma.consultationFollowUpMessage.findMany({
      where: { consultationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      consultationId: m.consultationId,
      senderUserId: m.senderUserId,
      senderRole:
        m.senderUserId === customerId
          ? 'CUSTOMER'
          : m.senderUserId === astrologerUserId
            ? 'ASTROLOGER'
            : 'CUSTOMER',
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  private async sendMessage(input: {
    consultation: {
      id: string;
      customerId: string;
      status: ConsultationStatus;
      completedAt: Date | null;
      appointments: Array<{ status: string }>;
      astrologer: { userId: string };
    };
    senderUserId: string;
    senderIsCustomer: boolean;
    rawBody: string;
  }): Promise<FollowUpMessageView> {
    const body = normalizeMessageBody(input.rawBody);
    if (!body) {
      throw new BadRequestException('Message body is required');
    }
    if (body.length > FOLLOW_UP_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException('Message body is too long');
    }

    const row = input.consultation;
    if (
      !isSuccessfullyCompleted({
        consultationStatus: row.status,
        appointmentStatus: row.appointments[0]?.status ?? null,
      })
    ) {
      throw new ConflictException(
        'Follow-up messaging is only available after completion',
      );
    }
    if (!row.completedAt || !isFollowUpWindowOpen(row.completedAt)) {
      throw new ConflictException('Follow-up messaging window has closed');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Serialize customer sends against the consultation row so the limit
      // cannot be exceeded by concurrent requests.
      await tx.$queryRaw`
        SELECT \`id\` FROM \`Consultation\` WHERE \`id\` = ${row.id} FOR UPDATE
      `;

      if (input.senderIsCustomer) {
        const sent = await tx.consultationFollowUpMessage.count({
          where: {
            consultationId: row.id,
            senderUserId: row.customerId,
          },
        });
        if (sent >= FOLLOW_UP_CUSTOMER_MESSAGE_LIMIT) {
          throw new ConflictException(
            'Customer follow-up message limit reached',
          );
        }
      }

      // Re-check completion + window inside the lock.
      const locked = await tx.consultation.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          appointments: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      });
      if (
        !isSuccessfullyCompleted({
          consultationStatus: locked.status,
          appointmentStatus: locked.appointments[0]?.status ?? null,
        })
      ) {
        throw new ConflictException(
          'Follow-up messaging is only available after completion',
        );
      }
      if (!locked.completedAt || !isFollowUpWindowOpen(locked.completedAt)) {
        throw new ConflictException('Follow-up messaging window has closed');
      }

      return tx.consultationFollowUpMessage.create({
        data: {
          consultationId: row.id,
          senderUserId: input.senderUserId,
          body,
        },
      });
    });

    return {
      id: created.id,
      consultationId: created.consultationId,
      senderUserId: created.senderUserId,
      senderRole: input.senderIsCustomer ? 'CUSTOMER' : 'ASTROLOGER',
      body: created.body,
      createdAt: created.createdAt.toISOString(),
    };
  }

  private assertMessagingReadable(row: {
    status: ConsultationStatus;
    appointments: Array<{ status: string }>;
  }) {
    if (
      !isSuccessfullyCompleted({
        consultationStatus: row.status,
        appointmentStatus: row.appointments[0]?.status ?? null,
      })
    ) {
      throw new ConflictException(
        'Follow-up messaging is only available after completion',
      );
    }
  }

  private async requireCustomerParticipant(user: User, consultationId: string) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const row = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        astrologer: { select: { userId: true } },
        appointments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    if (!row || row.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }
    return row;
  }

  private async requireAstrologerParticipant(
    user: User,
    consultationId: string,
  ) {
    if (user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException('ASTROLOGER role required');
    }
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      throw new ForbiddenException('Astrologer profile required');
    }
    const row = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        astrologer: { select: { userId: true } },
        appointments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    if (!row || row.astrologerId !== profile.id) {
      throw new NotFoundException('Consultation not found');
    }
    return row;
  }
}

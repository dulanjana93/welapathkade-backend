import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsultationProposal,
  ConsultationStatus,
  ProposalStatus,
  User,
  UserRole,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AvailabilityService } from '../availability/availability.service';
import { BookingGuardService } from '../availability/booking-guard.service';
import { OccupancyService } from '../availability/occupancy.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConsultationProposalDto } from './dto/proposal.dto';
import { summarizeProposals, toProposalView } from './proposal.mapper';
import {
  canCustomerAcceptProposal,
  canCustomerRejectProposal,
} from './proposal.state';

@Injectable()
export class ConsultationProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly bookingGuard: BookingGuardService,
    private readonly occupancy: OccupancyService,
    private readonly notifications: NotificationService,
  ) {}

  async createForAstrologer(
    user: User,
    consultationId: string,
    dto: CreateConsultationProposalDto,
  ) {
    const profile = await this.requireAstrologerProfile(user);
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || consultation.astrologerId !== profile.id) {
      throw new NotFoundException('Consultation not found');
    }
    if (consultation.status !== ConsultationStatus.ACCEPTED) {
      throw new ConflictException(
        `Cannot create proposal when consultation status is ${consultation.status}`,
      );
    }

    const proposedStartAt = new Date(dto.proposedStartAt);
    if (Number.isNaN(proposedStartAt.getTime())) {
      throw new BadRequestException('proposedStartAt is invalid');
    }
    const durationMinutes = dto.durationMinutes;
    const proposedEndAt = DateTime.fromJSDate(proposedStartAt, { zone: 'utc' })
      .plus({ minutes: durationMinutes })
      .toJSDate();

    const occupied = await this.occupancy.loadOccupiedIntervals({
      astrologerId: profile.id,
      excludeConsultationId: consultationId,
    });

    // Validate availability before taking the booking lock.
    await this.availability.assertProposedSlotEligible({
      astrologerId: profile.id,
      proposedStartAt,
      durationMinutes,
      occupied,
    });

    const created = await this.bookingGuard.withAstrologerLock(
      profile.id,
      async (tx) => {
        const pending = await tx.consultationProposal.findFirst({
          where: {
            consultationId,
            status: ProposalStatus.PENDING,
          },
        });
        if (pending) {
          throw new ConflictException(
            'A PENDING proposal already exists for this consultation',
          );
        }

        const accepted = await tx.consultationProposal.findFirst({
          where: {
            consultationId,
            status: ProposalStatus.ACCEPTED,
          },
        });
        if (accepted) {
          throw new ConflictException(
            'An ACCEPTED proposal already exists for this consultation',
          );
        }

        // Re-check consultation status under lock.
        const fresh = await tx.consultation.findUnique({
          where: { id: consultationId },
        });
        if (!fresh || fresh.astrologerId !== profile.id) {
          throw new NotFoundException('Consultation not found');
        }
        if (fresh.status !== ConsultationStatus.ACCEPTED) {
          throw new ConflictException(
            `Cannot create proposal when consultation status is ${fresh.status}`,
          );
        }

        const lockedOccupied = await this.occupancy.loadOccupiedIntervals({
          astrologerId: profile.id,
          excludeConsultationId: consultationId,
          db: tx,
        });
        await this.availability.assertProposedSlotEligible({
          astrologerId: profile.id,
          proposedStartAt,
          durationMinutes,
          occupied: lockedOccupied,
        });

        const proposal = await tx.consultationProposal.create({
          data: {
            consultationId,
            proposedStartAt,
            proposedEndAt,
            durationMinutes,
            status: ProposalStatus.PENDING,
          },
        });

        // Same transaction (and lock) as the proposal row. Deduplicated by
        // the new proposal id; the consultation id is the navigation target.
        const notificationId = await this.notifications.notifyUser(
          tx,
          fresh.customerId,
          {
            type: 'PROPOSAL_CREATED',
            consultationId,
            proposalId: proposal.id,
          },
        );
        return { proposal, notificationId };
      },
    );

    // Lock released and transaction committed: start delivery now.
    this.notifications.deliverAfterCommit([created.notificationId]);

    return toProposalView(created.proposal);
  }

  async listForAstrologer(user: User, consultationId: string) {
    const profile = await this.requireAstrologerProfile(user);
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || consultation.astrologerId !== profile.id) {
      throw new NotFoundException('Consultation not found');
    }
    return this.listProposals(consultationId);
  }

  async listForCustomer(user: User, consultationId: string) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || consultation.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }
    return this.listProposals(consultationId);
  }

  async acceptForCustomer(
    user: User,
    consultationId: string,
    proposalId: string,
  ) {
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
        `Cannot accept proposal when consultation status is ${consultation.status}`,
      );
    }

    const proposal = await this.prisma.consultationProposal.findFirst({
      where: { id: proposalId, consultationId },
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    if (!canCustomerAcceptProposal(proposal.status)) {
      throw new ConflictException(
        `Cannot accept proposal in status ${proposal.status}`,
      );
    }

    const now = new Date();
    const accepted = await this.bookingGuard.withAstrologerLock(
      consultation.astrologerId,
      async (tx) => {
        const freshConsultation = await tx.consultation.findUnique({
          where: { id: consultationId },
        });
        if (!freshConsultation || freshConsultation.customerId !== user.id) {
          throw new NotFoundException('Consultation not found');
        }
        if (freshConsultation.status !== ConsultationStatus.ACCEPTED) {
          throw new ConflictException(
            `Cannot accept proposal when consultation status is ${freshConsultation.status}`,
          );
        }

        const freshProposal = await tx.consultationProposal.findFirst({
          where: { id: proposalId, consultationId },
        });
        if (!freshProposal) {
          throw new NotFoundException('Proposal not found');
        }
        if (!canCustomerAcceptProposal(freshProposal.status)) {
          throw new ConflictException(
            `Cannot accept proposal in status ${freshProposal.status}`,
          );
        }

        const alreadyAccepted = await tx.consultationProposal.findFirst({
          where: {
            consultationId,
            status: ProposalStatus.ACCEPTED,
          },
        });
        if (alreadyAccepted) {
          throw new ConflictException(
            'An ACCEPTED proposal already exists for this consultation',
          );
        }

        const occupied = await this.occupancy.loadOccupiedIntervals({
          astrologerId: consultation.astrologerId,
          excludeConsultationId: consultationId,
          now,
          db: tx,
        });
        await this.availability.assertProposedSlotEligible({
          astrologerId: consultation.astrologerId,
          proposedStartAt: freshProposal.proposedStartAt,
          durationMinutes: freshProposal.durationMinutes,
          occupied,
          now,
        });

        const updated = await tx.consultationProposal.updateMany({
          where: {
            id: proposalId,
            consultationId,
            status: ProposalStatus.PENDING,
          },
          data: {
            status: ProposalStatus.ACCEPTED,
            respondedAt: now,
          },
        });
        if (updated.count === 0) {
          throw new ConflictException('Proposal could not be accepted');
        }

        await tx.consultationProposal.updateMany({
          where: {
            consultationId,
            status: ProposalStatus.PENDING,
            id: { not: proposalId },
          },
          data: {
            status: ProposalStatus.SUPERSEDED,
            respondedAt: now,
          },
        });

        const acceptedProposal =
          await tx.consultationProposal.findUniqueOrThrow({
            where: { id: proposalId },
          });

        // "Accepted, payment pending" for the astrologer. consultation.astrologerId
        // is an AstrologerProfile id, so the user is resolved from the profile.
        const notificationId = await this.notifications.notifyAstrologerProfile(
          tx,
          consultation.astrologerId,
          {
            type: 'PROPOSAL_ACCEPTED',
            consultationId,
            proposalId,
          },
        );
        return { proposal: acceptedProposal, notificationId };
      },
    );

    this.notifications.deliverAfterCommit([accepted.notificationId]);

    return toProposalView(accepted.proposal);
  }

  async rejectForCustomer(
    user: User,
    consultationId: string,
    proposalId: string,
  ) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || consultation.customerId !== user.id) {
      throw new NotFoundException('Consultation not found');
    }

    const proposal = await this.prisma.consultationProposal.findFirst({
      where: { id: proposalId, consultationId },
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    if (!canCustomerRejectProposal(proposal.status)) {
      throw new ConflictException(
        `Cannot reject proposal in status ${proposal.status}`,
      );
    }

    const now = new Date();
    // State change and notification row commit atomically. A lost guard
    // (count !== 1) throws inside the transaction, so nothing is written.
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.consultationProposal.updateMany({
        where: {
          id: proposalId,
          consultationId,
          status: ProposalStatus.PENDING,
        },
        data: {
          status: ProposalStatus.REJECTED,
          respondedAt: now,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Proposal could not be rejected');
      }

      const rejected = await tx.consultationProposal.findUniqueOrThrow({
        where: { id: proposalId },
      });
      const notificationId = await this.notifications.notifyAstrologerProfile(
        tx,
        consultation.astrologerId,
        {
          type: 'PROPOSAL_REJECTED',
          consultationId,
          proposalId,
        },
      );
      return { proposal: rejected, notificationId };
    });

    this.notifications.deliverAfterCommit([result.notificationId]);

    return toProposalView(result.proposal);
  }

  /** Load proposal history for consultation detail enrichment. */
  async loadProposalSummary(consultationId: string) {
    const rows = await this.prisma.consultationProposal.findMany({
      where: { consultationId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return summarizeProposals(rows);
  }

  /** Bulk variant for list views: one query, summaries keyed by consultation id. */
  async loadProposalSummaries(consultationIds: string[]) {
    const grouped = new Map<string, ConsultationProposal[]>();
    if (consultationIds.length === 0) {
      return new Map<string, ReturnType<typeof summarizeProposals>>();
    }
    const rows = await this.prisma.consultationProposal.findMany({
      where: { consultationId: { in: consultationIds } },
      orderBy: [{ createdAt: 'desc' }],
    });
    for (const row of rows) {
      const list = grouped.get(row.consultationId) ?? [];
      list.push(row);
      grouped.set(row.consultationId, list);
    }
    return new Map(
      [...grouped].map(([id, list]) => [id, summarizeProposals(list)] as const),
    );
  }

  private async listProposals(consultationId: string) {
    const rows = await this.prisma.consultationProposal.findMany({
      where: { consultationId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toProposalView);
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
}

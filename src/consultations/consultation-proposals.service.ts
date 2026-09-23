import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsultationStatus,
  ProposalStatus,
  User,
  UserRole,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AvailabilityService } from '../availability/availability.service';
import type { OccupiedInterval } from '../availability/availability.calculator';
import { BookingGuardService } from '../availability/booking-guard.service';
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

    const occupied = await this.loadBlockingIntervals(
      profile.id,
      consultationId,
    );

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

        return tx.consultationProposal.create({
          data: {
            consultationId,
            proposedStartAt,
            proposedEndAt,
            durationMinutes,
            status: ProposalStatus.PENDING,
          },
        });
      },
    );

    return toProposalView(created);
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
    const accepted = await this.prisma.$transaction(async (tx) => {
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

      // Atomically supersede any other PENDING proposals (race / history safety).
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

      return tx.consultationProposal.findUniqueOrThrow({
        where: { id: proposalId },
      });
    });

    return toProposalView(accepted);
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
    const updated = await this.prisma.consultationProposal.updateMany({
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
    if (updated.count === 0) {
      throw new ConflictException('Proposal could not be rejected');
    }

    const rejected = await this.prisma.consultationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    return toProposalView(rejected);
  }

  /** Load proposal history for consultation detail enrichment. */
  async loadProposalSummary(consultationId: string) {
    const rows = await this.prisma.consultationProposal.findMany({
      where: { consultationId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return summarizeProposals(rows);
  }

  private async listProposals(consultationId: string) {
    const rows = await this.prisma.consultationProposal.findMany({
      where: { consultationId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toProposalView);
  }

  /**
   * ACCEPTED proposals for other consultations on this astrologer are treated
   * as soft occupancy until Phase 5B reservations exist. Does not permanently
   * block slots and does not create reservation rows.
   */
  private async loadBlockingIntervals(
    astrologerId: string,
    excludeConsultationId: string,
  ): Promise<OccupiedInterval[]> {
    const accepted = await this.prisma.consultationProposal.findMany({
      where: {
        status: ProposalStatus.ACCEPTED,
        consultationId: { not: excludeConsultationId },
        consultation: { astrologerId },
      },
      select: {
        proposedStartAt: true,
        proposedEndAt: true,
      },
    });
    return accepted.map((p) => ({
      startAt: p.proposedStartAt,
      endAt: p.proposedEndAt,
    }));
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AstrologerApplicationStatus,
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  Prisma,
  ServiceStatus,
  User,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AvailabilityService } from '../availability/availability.service';
import {
  isPriceWithinRange,
  toDecimal,
  toMoneyString,
} from '../common/money/money';
import { ConsultationReviewsService } from '../consultations/consultation-reviews.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  toOwnProfileView,
  toOwnServiceView,
  toPublicAstrologerView,
} from './astrologer.mapper';
import {
  AssignAstrologerServiceDto,
  CreateAstrologerProfileDto,
  ReviewAstrologerApplicationDto,
  UpdateAstrologerProfileDto,
  UpdateAstrologerServiceDto,
  UpdateAstrologerStatusDto,
  UpdateOnlineStatusDto,
} from './dto/astrologer.dto';

@Injectable()
export class AstrologersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly availabilityService: AvailabilityService,
    private readonly reviews: ConsultationReviewsService,
  ) {}

  assertAstrologerRole(user: User): void {
    if (user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException('Astrologer role required');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Astrologer account is not active');
    }
  }

  async getOwnProfile(user: User) {
    this.assertAstrologerRole(user);
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
      include: {
        services: {
          where: { status: AstrologerServiceStatus.ACTIVE },
          take: 1,
        },
      },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }
    const ratingSummary = await this.reviews.aggregateForAstrologer(profile.id);
    return toOwnProfileView(profile, {
      hasActiveService: profile.services.length > 0,
      userActive: user.status === UserStatus.ACTIVE,
      ratingSummary,
      hasProfilePicture: user.profilePictureFileId != null,
    });
  }

  async createOwnProfile(user: User, dto: CreateAstrologerProfileDto) {
    this.assertAstrologerRole(user);
    const existing = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (existing) {
      throw new ConflictException('Astrologer profile already exists');
    }

    const profile = await this.prisma.astrologerProfile.create({
      data: {
        userId: user.id,
        displayName: dto.displayName.trim(),
        bio: dto.bio?.trim() || null,
        experienceYears: dto.experienceYears ?? 0,
        photo: dto.photo?.trim() || null,
        city: dto.city?.trim() || null,
        district: dto.district?.trim() || null,
        status: AstrologerProfileStatus.INACTIVE,
        application: {
          create: {
            status: AstrologerApplicationStatus.DRAFT,
          },
        },
        bookingGuard: { create: {} },
      },
    });

    return toOwnProfileView(profile, {
      hasActiveService: false,
      userActive: user.status === UserStatus.ACTIVE,
      hasProfilePicture: user.profilePictureFileId != null,
    });
  }

  async updateOwnProfile(user: User, dto: UpdateAstrologerProfileDto) {
    this.assertAstrologerRole(user);
    const existing = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!existing) {
      throw new NotFoundException('Astrologer profile not found');
    }

    const profile = await this.prisma.astrologerProfile.update({
      where: { id: existing.id },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName.trim() }
          : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio?.trim() || null } : {}),
        ...(dto.experienceYears !== undefined
          ? { experienceYears: dto.experienceYears }
          : {}),
        ...(dto.photo !== undefined
          ? { photo: dto.photo?.trim() || null }
          : {}),
        ...(dto.city !== undefined ? { city: dto.city?.trim() || null } : {}),
        ...(dto.district !== undefined
          ? { district: dto.district?.trim() || null }
          : {}),
      },
      include: {
        services: {
          where: { status: AstrologerServiceStatus.ACTIVE },
          take: 1,
        },
      },
    });

    return toOwnProfileView(profile, {
      hasActiveService: profile.services.length > 0,
      userActive: user.status === UserStatus.ACTIVE,
      hasProfilePicture: user.profilePictureFileId != null,
    });
  }

  async listOwnServices(user: User) {
    const profile = await this.requireOwnProfile(user);
    const links = await this.prisma.astrologerService.findMany({
      where: { astrologerId: profile.id },
      include: { service: true },
      orderBy: { createdAt: 'asc' },
    });
    return links.map(toOwnServiceView);
  }

  async assignService(user: User, dto: AssignAstrologerServiceDto) {
    const profile = await this.requireOwnProfile(user);
    const service = await this.prisma.service.findUnique({
      where: { id: dto.serviceId },
    });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    if (service.status !== ServiceStatus.ACTIVE) {
      throw new BadRequestException('Cannot assign an inactive service');
    }

    const price = toDecimal(dto.price);
    if (!isPriceWithinRange(price, service.minPrice, service.maxPrice)) {
      throw new BadRequestException(
        `Price must be between ${service.minPrice.toFixed(2)} and ${service.maxPrice.toFixed(2)}`,
      );
    }

    const existing = await this.prisma.astrologerService.findUnique({
      where: {
        astrologerId_serviceId: {
          astrologerId: profile.id,
          serviceId: service.id,
        },
      },
    });

    if (existing) {
      if (existing.status === AstrologerServiceStatus.INACTIVE) {
        const reactivated = await this.prisma.astrologerService.update({
          where: { id: existing.id },
          data: {
            price,
            status: AstrologerServiceStatus.ACTIVE,
          },
          include: { service: true },
        });
        return toOwnServiceView(reactivated);
      }
      throw new ConflictException(
        'Service already assigned to this astrologer',
      );
    }

    try {
      const created = await this.prisma.astrologerService.create({
        data: {
          astrologerId: profile.id,
          serviceId: service.id,
          price,
          status: AstrologerServiceStatus.ACTIVE,
        },
        include: { service: true },
      });
      return toOwnServiceView(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Service already assigned to this astrologer',
        );
      }
      throw error;
    }
  }

  async updateOwnService(
    user: User,
    serviceId: string,
    dto: UpdateAstrologerServiceDto,
  ) {
    const profile = await this.requireOwnProfile(user);
    const link = await this.prisma.astrologerService.findUnique({
      where: {
        astrologerId_serviceId: {
          astrologerId: profile.id,
          serviceId,
        },
      },
      include: { service: true },
    });
    if (!link) {
      throw new NotFoundException('Astrologer service not found');
    }

    let price = link.price;
    if (dto.price !== undefined) {
      price = toDecimal(dto.price);
      if (
        !isPriceWithinRange(price, link.service.minPrice, link.service.maxPrice)
      ) {
        throw new BadRequestException(
          `Price must be between ${link.service.minPrice.toFixed(2)} and ${link.service.maxPrice.toFixed(2)}`,
        );
      }
    }

    if (
      dto.status === AstrologerServiceStatus.ACTIVE &&
      link.service.status !== ServiceStatus.ACTIVE
    ) {
      throw new BadRequestException(
        'Cannot activate assignment for an inactive platform service',
      );
    }

    const updated = await this.prisma.astrologerService.update({
      where: { id: link.id },
      data: {
        ...(dto.price !== undefined ? { price } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      include: { service: true },
    });
    return toOwnServiceView(updated);
  }

  async deactivateOwnService(user: User, serviceId: string) {
    const profile = await this.requireOwnProfile(user);
    const link = await this.prisma.astrologerService.findUnique({
      where: {
        astrologerId_serviceId: {
          astrologerId: profile.id,
          serviceId,
        },
      },
      include: { service: true },
    });
    if (!link) {
      throw new NotFoundException('Astrologer service not found');
    }

    const updated = await this.prisma.astrologerService.update({
      where: { id: link.id },
      data: { status: AstrologerServiceStatus.INACTIVE },
      include: { service: true },
    });
    return toOwnServiceView(updated);
  }

  async listDiscoverable(filters: {
    serviceId?: string;
    minPrice?: number;
    maxPrice?: number;
  }) {
    const priceFilter: Prisma.DecimalFilter | undefined =
      filters.minPrice !== undefined || filters.maxPrice !== undefined
        ? {
            ...(filters.minPrice !== undefined
              ? { gte: toDecimal(filters.minPrice) }
              : {}),
            ...(filters.maxPrice !== undefined
              ? { lte: toDecimal(filters.maxPrice) }
              : {}),
          }
        : undefined;

    const profiles = await this.prisma.astrologerProfile.findMany({
      where: {
        status: AstrologerProfileStatus.ACTIVE,
        user: {
          role: UserRole.ASTROLOGER,
          status: UserStatus.ACTIVE,
        },
        services: {
          some: {
            status: AstrologerServiceStatus.ACTIVE,
            service: { status: ServiceStatus.ACTIVE },
            ...(filters.serviceId ? { serviceId: filters.serviceId } : {}),
            ...(priceFilter ? { price: priceFilter } : {}),
          },
        },
      },
      include: {
        user: { select: { profilePictureFileId: true } },
        services: {
          where: {
            status: AstrologerServiceStatus.ACTIVE,
            service: { status: ServiceStatus.ACTIVE },
            ...(filters.serviceId ? { serviceId: filters.serviceId } : {}),
            ...(priceFilter ? { price: priceFilter } : {}),
          },
          include: { service: true },
          orderBy: { price: 'asc' },
        },
      },
      orderBy: { displayName: 'asc' },
    });

    const visible = profiles.filter((p) => p.services.length > 0);
    const aggregates = await this.reviews.aggregateForAstrologers(
      visible.map((p) => p.id),
    );
    return visible.map((p) =>
      toPublicAstrologerView(
        p,
        p.services,
        aggregates.get(p.id) ?? { averageRating: null, reviewCount: 0 },
        { hasProfilePicture: p.user?.profilePictureFileId != null },
      ),
    );
  }

  async getDiscoverableById(id: string) {
    const profile = await this.prisma.astrologerProfile.findFirst({
      where: {
        id,
        status: AstrologerProfileStatus.ACTIVE,
        user: {
          role: UserRole.ASTROLOGER,
          status: UserStatus.ACTIVE,
        },
      },
      include: {
        user: { select: { profilePictureFileId: true } },
        services: {
          where: {
            status: AstrologerServiceStatus.ACTIVE,
            service: { status: ServiceStatus.ACTIVE },
          },
          include: { service: true },
          orderBy: { price: 'asc' },
        },
      },
    });

    if (!profile || profile.services.length === 0) {
      throw new NotFoundException('Astrologer not found');
    }

    const ratingSummary = await this.reviews.aggregateForAstrologer(profile.id);
    return toPublicAstrologerView(profile, profile.services, ratingSummary, {
      hasProfilePicture: profile.user?.profilePictureFileId != null,
    });
  }

  listPublicReviews(astrologerId: string, page?: number, limit?: number) {
    return this.reviews.listPublicForAstrologer(astrologerId, page, limit);
  }

  async listOwnPublicReviews(user: User, page?: number, limit?: number) {
    this.assertAstrologerRole(user);
    const profile = await this.requireOwnProfile(user);
    return this.reviews.listPublicForAstrologer(profile.id, page, limit);
  }

  async getOwnRatingSummary(user: User) {
    this.assertAstrologerRole(user);
    const profile = await this.requireOwnProfile(user);
    return this.reviews.aggregateForAstrologer(profile.id);
  }

  /**
   * Persist the authenticated astrologer's Online/Offline preference.
   * Does not alter consultations, appointments or weekly availability.
   */
  async updateOwnOnlineStatus(user: User, dto: UpdateOnlineStatusDto) {
    this.assertAstrologerRole(user);
    const profile = await this.requireOwnProfile(user);
    const updated = await this.prisma.astrologerProfile.update({
      where: { id: profile.id },
      data: { isOnline: dto.isOnline === true },
    });
    return { id: updated.id, isOnline: updated.isOnline === true };
  }

  async adminUpdateStatus(id: string, dto: UpdateAstrologerStatusDto) {
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { id },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }

    const updated = await this.prisma.astrologerProfile.update({
      where: { id },
      data: { status: dto.status },
      include: {
        services: {
          where: { status: AstrologerServiceStatus.ACTIVE },
          take: 1,
        },
        user: true,
      },
    });

    return toOwnProfileView(updated, {
      hasActiveService: updated.services.length > 0,
      userActive: updated.user.status === UserStatus.ACTIVE,
      hasProfilePicture: updated.user.profilePictureFileId != null,
    });
  }

  async getOnboarding(user: User) {
    this.assertAstrologerRole(user);
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
      include: {
        application: true,
        services: {
          where: { status: AstrologerServiceStatus.ACTIVE },
          include: { service: true },
        },
      },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }

    const application =
      profile.application ??
      (await this.prisma.astrologerApplication.create({
        data: {
          astrologerProfileId: profile.id,
          status: AstrologerApplicationStatus.DRAFT,
        },
      }));

    const availabilityReady =
      await this.availabilityService.hasConfiguredAvailability(profile.id);
    const readiness = this.evaluateOnboardingReadiness(
      profile,
      profile.services,
      availabilityReady,
    );

    return {
      profile: toOwnProfileView(profile, {
        hasActiveService: profile.services.length > 0,
        userActive: user.status === UserStatus.ACTIVE,
        hasProfilePicture: user.profilePictureFileId != null,
      }),
      application: {
        id: application.id,
        status: application.status,
        rejectionReason:
          application.status === AstrologerApplicationStatus.REJECTED
            ? application.rejectionReason
            : null,
        submittedAt: application.submittedAt,
        reviewedAt: application.reviewedAt,
      },
      readiness,
      services: profile.services.map(toOwnServiceView),
    };
  }

  async getApplication(user: User) {
    const onboarding = await this.getOnboarding(user);
    return onboarding.application;
  }

  async submitApplication(user: User) {
    this.assertAstrologerRole(user);
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
      include: {
        application: true,
        services: {
          where: { status: AstrologerServiceStatus.ACTIVE },
          include: { service: true },
        },
      },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }

    let application = profile.application;
    if (!application) {
      application = await this.prisma.astrologerApplication.create({
        data: {
          astrologerProfileId: profile.id,
          status: AstrologerApplicationStatus.DRAFT,
        },
      });
    }

    if (
      application.status !== AstrologerApplicationStatus.DRAFT &&
      application.status !== AstrologerApplicationStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Application can only be submitted from DRAFT or REJECTED status',
      );
    }

    const availabilityReady =
      await this.availabilityService.hasConfiguredAvailability(profile.id);
    const readiness = this.evaluateOnboardingReadiness(
      profile,
      profile.services,
      availabilityReady,
    );
    if (!readiness.canSubmit) {
      throw new BadRequestException({
        message: 'Onboarding is incomplete',
        errors: readiness.errors,
      });
    }

    const updated = await this.prisma.astrologerApplication.update({
      where: { id: application.id },
      data: {
        status: AstrologerApplicationStatus.PENDING_REVIEW,
        submittedAt: new Date(),
        rejectionReason: null,
        reviewedAt: null,
        reviewedByAdminId: null,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      rejectionReason: null,
      submittedAt: updated.submittedAt,
      reviewedAt: updated.reviewedAt,
    };
  }

  async adminList(filters: {
    applicationStatus?: AstrologerApplicationStatus;
  }) {
    const profiles = await this.prisma.astrologerProfile.findMany({
      where: {
        ...(filters.applicationStatus
          ? { application: { status: filters.applicationStatus } }
          : {}),
      },
      include: {
        user: true,
        application: true,
        services: {
          where: { status: AstrologerServiceStatus.ACTIVE },
          include: { service: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return profiles.map((profile) => this.toAdminAstrologerView(profile));
  }

  async adminGetById(id: string) {
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { id },
      include: {
        user: true,
        application: true,
        services: { include: { service: true } },
      },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }
    const availability =
      await this.availabilityService.getScheduleForAstrologer(profile.id);
    return {
      ...this.toAdminAstrologerView(profile),
      availability,
    };
  }

  async adminReviewApplication(
    id: string,
    admin: User,
    dto: ReviewAstrologerApplicationDto,
    ip?: string | null,
  ) {
    if (dto.action === 'REJECT' && !dto.rejectionReason?.trim()) {
      throw new BadRequestException(
        'rejectionReason is required when rejecting',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.astrologerProfile.findUnique({
        where: { id },
        include: {
          application: true,
          services: {
            where: { status: AstrologerServiceStatus.ACTIVE },
            include: { service: true },
          },
          user: true,
        },
      });
      if (!profile || !profile.application) {
        throw new NotFoundException('Astrologer application not found');
      }

      if (
        profile.application.status !==
        AstrologerApplicationStatus.PENDING_REVIEW
      ) {
        throw new BadRequestException(
          'Only PENDING_REVIEW applications can be reviewed',
        );
      }

      const oldData = {
        applicationStatus: profile.application.status,
        profileStatus: profile.status,
      };

      if (dto.action === 'APPROVE') {
        const availabilityReady =
          await this.availabilityService.hasConfiguredAvailability(profile.id);
        const readiness = this.evaluateOnboardingReadiness(
          profile,
          profile.services,
          availabilityReady,
        );
        if (!readiness.canSubmit) {
          throw new BadRequestException({
            message: 'Cannot approve incomplete onboarding',
            errors: readiness.errors,
          });
        }

        const application = await tx.astrologerApplication.update({
          where: { id: profile.application.id },
          data: {
            status: AstrologerApplicationStatus.APPROVED,
            reviewedAt: new Date(),
            reviewedByAdminId: admin.id,
            rejectionReason: null,
          },
        });
        const updatedProfile = await tx.astrologerProfile.update({
          where: { id: profile.id },
          data: { status: AstrologerProfileStatus.ACTIVE },
        });

        return {
          applicationId: application.id,
          action: 'ASTROLOGER_APPLICATION_APPROVE' as const,
          oldData,
          applicationStatus: application.status,
          profileStatus: updatedProfile.status,
          rejectionReason: null as string | null,
        };
      }

      const application = await tx.astrologerApplication.update({
        where: { id: profile.application.id },
        data: {
          status: AstrologerApplicationStatus.REJECTED,
          rejectionReason: dto.rejectionReason!.trim(),
          reviewedAt: new Date(),
          reviewedByAdminId: admin.id,
        },
      });

      return {
        applicationId: application.id,
        action: 'ASTROLOGER_APPLICATION_REJECT' as const,
        oldData,
        applicationStatus: application.status,
        profileStatus: profile.status,
        rejectionReason: application.rejectionReason,
      };
    });

    await this.auditService.record({
      adminUserId: admin.id,
      action: result.action,
      entityType: 'AstrologerApplication',
      entityId: result.applicationId,
      oldData: result.oldData,
      newData: {
        applicationStatus: result.applicationStatus,
        profileStatus: result.profileStatus,
        rejectionReason: result.rejectionReason,
      },
      ip,
    });

    return {
      applicationStatus: result.applicationStatus,
      profileStatus: result.profileStatus,
      rejectionReason: result.rejectionReason,
    };
  }
  private evaluateOnboardingReadiness(
    profile: {
      displayName: string;
      city: string | null;
      district: string | null;
    },
    services: Array<{
      price: Prisma.Decimal;
      status: AstrologerServiceStatus;
      service: {
        status: ServiceStatus;
        minPrice: Prisma.Decimal;
        maxPrice: Prisma.Decimal;
      };
    }>,
    availabilityReady: boolean,
  ) {
    const errors: string[] = [];
    if (profile.displayName.trim().length < 2) {
      errors.push('displayName is required');
    }
    if (!profile.city?.trim()) {
      errors.push('city is required');
    }
    if (!profile.district?.trim()) {
      errors.push('district is required');
    }

    const active = services.filter(
      (s) =>
        s.status === AstrologerServiceStatus.ACTIVE &&
        s.service.status === ServiceStatus.ACTIVE,
    );
    if (active.length === 0) {
      errors.push('at least one active service is required');
    }
    for (const link of active) {
      if (
        !isPriceWithinRange(
          link.price,
          link.service.minPrice,
          link.service.maxPrice,
        )
      ) {
        errors.push(
          `service price must be between ${toMoneyString(link.service.minPrice)} and ${toMoneyString(link.service.maxPrice)}`,
        );
      }
    }

    if (!availabilityReady) {
      errors.push('weekly availability is required');
    }

    return {
      canSubmit: errors.length === 0,
      errors,
      availabilityRequired: true,
      availabilityReady,
    };
  }

  private toAdminAstrologerView(profile: {
    id: string;
    displayName: string;
    bio: string | null;
    experienceYears: number;
    photo: string | null;
    city: string | null;
    district: string | null;
    status: AstrologerProfileStatus;
    createdAt: Date;
    updatedAt: Date;
    user: User;
    application: {
      id: string;
      status: AstrologerApplicationStatus;
      rejectionReason: string | null;
      submittedAt: Date | null;
      reviewedAt: Date | null;
    } | null;
    services: Array<{
      id: string;
      serviceId: string;
      price: Prisma.Decimal;
      status: AstrologerServiceStatus;
      createdAt: Date;
      updatedAt: Date;
      service: {
        code: string;
        nameSi: string;
        nameEn: string;
        minPrice: Prisma.Decimal;
        maxPrice: Prisma.Decimal;
        status: ServiceStatus;
      };
    }>;
  }) {
    return {
      id: profile.id,
      displayName: profile.displayName,
      bio: profile.bio,
      experienceYears: profile.experienceYears,
      photo: profile.photo,
      city: profile.city,
      district: profile.district,
      status: profile.status,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      user: {
        id: profile.user.id,
        name: profile.user.name,
        phone: profile.user.phone,
        role: profile.user.role,
        status: profile.user.status,
        language: profile.user.language,
        referralCode: profile.user.referralCode,
        referredByUserId: profile.user.referredByUserId,
      },
      application: profile.application
        ? {
            id: profile.application.id,
            status: profile.application.status,
            rejectionReason: profile.application.rejectionReason,
            submittedAt: profile.application.submittedAt,
            reviewedAt: profile.application.reviewedAt,
          }
        : null,
      services: profile.services.map(toOwnServiceView),
    };
  }

  private async requireOwnProfile(user: User) {
    this.assertAstrologerRole(user);
    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      throw new NotFoundException('Astrologer profile not found');
    }
    return profile;
  }
}

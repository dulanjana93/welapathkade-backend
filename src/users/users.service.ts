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
  Language,
  Prisma,
  User,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  normalizeBillingInput,
  toBillingProfileView,
  type BillingProfileInput,
} from './billing-profile';
import { generateReferralCode } from '../common/crypto/hashing';
import { hashPassword } from '../common/crypto/password';
import { PrismaService } from '../prisma/prisma.service';

/** Admin audit action for Phase C referral attribution corrections. */
export const REFERRAL_ATTRIBUTION_CORRECT_ACTION =
  'REFERRAL_ATTRIBUTION_CORRECT';

const REFERRAL_CORRECTION_TARGET_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.PUBLIC,
  UserRole.ASTROLOGER,
]);

export type PublicUserView = {
  id: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  language: Language;
  referralCode: string;
  referredByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SelfAuthView = PublicUserView & {
  phone: string;
  email?: string | null;
  hasProfilePicture: boolean;
  profileStatus?: AstrologerProfileStatus | null;
  applicationStatus?: AstrologerApplicationStatus | null;
  rejectionReason?: string | null;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  toPublicView(user: User): PublicUserView {
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      status: user.status,
      language: user.language,
      referralCode: user.referralCode,
      referredByUserId: user.referredByUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /** Own profile may include phone/email; never expose passwordHash. */
  toSelfView(user: User): SelfAuthView {
    return {
      ...this.toPublicView(user),
      phone: user.phone,
      email: user.email,
      hasProfilePicture: user.profilePictureFileId != null,
    };
  }

  async toAuthMeView(user: User): Promise<SelfAuthView> {
    const base = this.toSelfView(user);
    if (user.role !== UserRole.ASTROLOGER) {
      return base;
    }

    const profile = await this.prisma.astrologerProfile.findUnique({
      where: { userId: user.id },
      include: { application: true },
    });

    return {
      ...base,
      profileStatus: profile?.status ?? null,
      applicationStatus: profile?.application?.status ?? null,
      rejectionReason:
        profile?.application?.status === AstrologerApplicationStatus.REJECTED
          ? (profile.application?.rejectionReason ?? null)
          : null,
    };
  }

  /**
   * Billing details for the authenticated public customer. Incomplete rows
   * are returned so the client can show what is still missing.
   */
  getBillingProfile(user: User) {
    this.assertPublicCustomer(user);
    return toBillingProfileView(user);
  }

  /**
   * Creates or replaces billing columns on the authenticated customer.
   * Account phone, display name, and login email are left unchanged.
   */
  async upsertBillingProfile(user: User, input: BillingProfileInput) {
    this.assertPublicCustomer(user);
    const billing = normalizeBillingInput(input);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        billingFirstName: billing.firstName,
        billingLastName: billing.lastName,
        billingEmail: billing.email,
        billingAddress: billing.address,
        billingCity: billing.city,
        billingCountry: billing.country,
      },
    });
    return toBillingProfileView(updated);
  }

  private assertPublicCustomer(user: User) {
    if (user.role !== UserRole.PUBLIC) {
      throw new ForbiddenException('PUBLIC role required');
    }
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async getByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async resolvePublicReferrer(referralCode: string): Promise<User> {
    const referrer = await this.prisma.user.findUnique({
      where: { referralCode },
    });

    if (!referrer || referrer.role !== UserRole.PUBLIC) {
      throw new BadRequestException('Invalid referral code');
    }

    if (referrer.status === UserStatus.SUSPENDED) {
      throw new BadRequestException('Invalid referral code');
    }

    return referrer;
  }

  async createPublicUser(params: {
    phone: string;
    name: string;
    language?: Language;
    referredByUserId?: string | null;
  }): Promise<User> {
    const language = params.language ?? Language.SI;
    const referredByUserId = params.referredByUserId ?? null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const referralCode = generateReferralCode();
      try {
        return await this.prisma.user.create({
          data: {
            phone: params.phone,
            name: params.name.trim(),
            role: UserRole.PUBLIC,
            status: UserStatus.ACTIVE,
            language,
            referralCode,
            referredByUserId,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const target = error.meta?.target;
          const fields = Array.isArray(target) ? target : [target];
          if (fields.includes('referralCode')) {
            continue;
          }
          if (fields.includes('phone')) {
            throw new BadRequestException('Phone number already registered');
          }
        }
        throw error;
      }
    }

    throw new BadRequestException('Unable to allocate referral code');
  }

  /** Creates ASTROLOGER user + INACTIVE profile + DRAFT application atomically. */
  async createAstrologerWithOnboarding(params: {
    phone: string;
    name: string;
    language?: Language;
    referredByUserId?: string | null;
  }): Promise<User> {
    const language = params.language ?? Language.SI;
    const referredByUserId = params.referredByUserId ?? null;
    const displayName = params.name.trim();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const referralCode = generateReferralCode();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              phone: params.phone,
              name: displayName,
              role: UserRole.ASTROLOGER,
              status: UserStatus.ACTIVE,
              language,
              referralCode,
              referredByUserId,
            },
          });

          const profile = await tx.astrologerProfile.create({
            data: {
              userId: user.id,
              displayName,
              status: AstrologerProfileStatus.INACTIVE,
              bookingGuard: { create: {} },
            },
          });

          await tx.astrologerApplication.create({
            data: {
              astrologerProfileId: profile.id,
              status: AstrologerApplicationStatus.DRAFT,
            },
          });

          return user;
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const target = error.meta?.target;
          const fields = Array.isArray(target) ? target : [target];
          if (fields.includes('referralCode')) {
            continue;
          }
          if (fields.includes('phone')) {
            throw new BadRequestException('Phone number already registered');
          }
        }
        throw error;
      }
    }

    throw new BadRequestException('Unable to allocate referral code');
  }

  async createAstrologerUser(params: {
    phone: string;
    name: string;
    language?: Language;
    referredByUserId?: string | null;
  }): Promise<User> {
    const existing = await this.findByPhone(params.phone);
    if (existing) {
      if (existing.role === UserRole.ASTROLOGER) {
        return existing;
      }
      throw new BadRequestException(
        'Phone number is already registered to a non-astrologer account',
      );
    }

    return this.createAstrologerWithOnboarding(params);
  }

  async createAdminUser(params: {
    email: string;
    password: string;
    name: string;
    phone?: string;
    language?: Language;
  }): Promise<User> {
    const email = params.email.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(params.password);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid password',
      );
    }
    const name = params.name.trim();
    const language = params.language ?? Language.EN;
    const phone = params.phone?.trim() || `admin:${email}`;

    const existingByEmail = await this.findByEmail(email);
    if (existingByEmail) {
      if (existingByEmail.role !== UserRole.ADMIN) {
        throw new BadRequestException(
          'Email is already registered to a non-admin account',
        );
      }
      return this.prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          name,
          passwordHash,
          language,
        },
      });
    }

    const existingByPhone = await this.findByPhone(phone);
    if (existingByPhone) {
      if (existingByPhone.role !== UserRole.ADMIN) {
        throw new BadRequestException(
          'Phone number is already registered to a non-admin account',
        );
      }
      return this.prisma.user.update({
        where: { id: existingByPhone.id },
        data: {
          email,
          name,
          passwordHash,
          language,
        },
      });
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const referralCode = generateReferralCode();
      try {
        return await this.prisma.user.create({
          data: {
            phone,
            email,
            passwordHash,
            name,
            role: UserRole.ADMIN,
            status: UserStatus.ACTIVE,
            language,
            referralCode,
            referredByUserId: null,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const target = error.meta?.target;
          const fields = Array.isArray(target) ? target : [target];
          if (fields.includes('referralCode')) {
            continue;
          }
          if (fields.includes('email')) {
            throw new BadRequestException('Email is already registered');
          }
          if (fields.includes('phone')) {
            throw new BadRequestException('Phone number already registered');
          }
        }
        throw error;
      }
    }

    throw new BadRequestException('Unable to allocate referral code');
  }

  toAdminUserView(
    user: User & {
      astrologerProfile?: {
        id: string;
        status: AstrologerProfileStatus;
        application?: { status: AstrologerApplicationStatus } | null;
      } | null;
    },
  ) {
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
      language: user.language,
      referralCode: user.referralCode,
      referredByUserId: user.referredByUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      astrologerProfileId: user.astrologerProfile?.id ?? null,
      profileStatus: user.astrologerProfile?.status ?? null,
      applicationStatus: user.astrologerProfile?.application?.status ?? null,
    };
  }

  async adminList(filters: { role?: UserRole; status?: UserStatus }) {
    const users = await this.prisma.user.findMany({
      where: {
        ...(filters.role ? { role: filters.role } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        astrologerProfile: {
          include: { application: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => this.toAdminUserView(user));
  }

  async adminGetById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        astrologerProfile: {
          include: { application: true },
        },
        referredBy: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      ...this.toAdminUserView(user),
      referredBy: user.referredBy
        ? {
            id: user.referredBy.id,
            name: user.referredBy.name,
            role: user.referredBy.role,
            status: user.referredBy.status,
          }
        : null,
    };
  }

  async adminUpdateStatus(params: {
    id: string;
    status: UserStatus;
    actorAdminId: string;
    ip?: string | null;
  }) {
    if (params.id === params.actorAdminId) {
      throw new BadRequestException(
        'You cannot change your own account status',
      );
    }

    const existing = await this.getByIdOrThrow(params.id);
    const updated = await this.prisma.user.update({
      where: { id: params.id },
      data: { status: params.status },
      include: {
        astrologerProfile: {
          include: { application: true },
        },
      },
    });

    await this.auditService.record({
      adminUserId: params.actorAdminId,
      action: 'USER_STATUS_UPDATE',
      entityType: 'User',
      entityId: updated.id,
      oldData: { status: existing.status },
      newData: { status: updated.status },
      ip: params.ip,
    });

    return this.toAdminUserView(updated);
  }

  /**
   * Admin-only correction of User.referredByUserId.
   * Future financial snapshots read the corrected graph; existing snapshots and
   * ledger rows are never rewritten here.
   */
  async adminCorrectReferralAttribution(params: {
    targetUserId: string;
    referrerUserId: string | null;
    reason: string;
    actorAdminId: string;
    ip?: string | null;
  }) {
    const reason = params.reason.trim();
    if (!reason) {
      throw new BadRequestException('Correction reason is required');
    }
    if (reason.length > 500) {
      throw new BadRequestException('Correction reason is too long');
    }

    const newReferrerUserId = params.referrerUserId;

    return this.prisma.$transaction(async (tx) => {
      // Serialize referral-graph mutations across admins (cycle-safe under concurrency).
      await this.acquireReferralCorrectionLock(tx);
      try {
        await this.lockUserRow(tx, params.targetUserId);

        const target = await tx.user.findUnique({
          where: { id: params.targetUserId },
          select: {
            id: true,
            role: true,
            referredByUserId: true,
          },
        });
        if (!target) {
          throw new NotFoundException('User not found');
        }
        if (!REFERRAL_CORRECTION_TARGET_ROLES.has(target.role)) {
          throw new BadRequestException(
            'Referral attribution can only be corrected for public or astrologer accounts',
          );
        }

        const previousReferrerUserId = target.referredByUserId;
        if (previousReferrerUserId === newReferrerUserId) {
          throw new BadRequestException('Referral attribution is unchanged');
        }

        if (newReferrerUserId !== null) {
          if (newReferrerUserId === target.id) {
            throw new BadRequestException('Self-referral is not allowed');
          }
          await this.assertEligiblePublicReferrer(tx, newReferrerUserId);
          await this.assertNoReferralCycle(tx, target.id, newReferrerUserId);
        }

        const claimed = await tx.user.updateMany({
          where: {
            id: target.id,
            referredByUserId: previousReferrerUserId,
          },
          data: { referredByUserId: newReferrerUserId },
        });
        if (claimed.count !== 1) {
          throw new ConflictException(
            'Referral attribution changed concurrently; retry the correction',
          );
        }

        const correction = await tx.referralAttributionCorrection.create({
          data: {
            targetUserId: target.id,
            previousReferrerUserId,
            newReferrerUserId,
            adminUserId: params.actorAdminId,
            reason,
          },
        });

        const audit = await this.auditService.record(
          {
            adminUserId: params.actorAdminId,
            action: REFERRAL_ATTRIBUTION_CORRECT_ACTION,
            entityType: 'User',
            entityId: target.id,
            oldData: { referredByUserId: previousReferrerUserId },
            newData: {
              referredByUserId: newReferrerUserId,
              reason,
              correctionId: correction.id,
            },
            ip: params.ip,
          },
          tx,
        );

        return {
          userId: target.id,
          referredByUserId: newReferrerUserId,
          previousReferrerUserId,
          correctionId: correction.id,
          auditLogId: audit.id,
          correctedAt: correction.createdAt.toISOString(),
          reason,
        };
      } finally {
        await this.releaseReferralCorrectionLock(tx);
      }
    });
  }

  private async acquireReferralCorrectionLock(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      Array<{ acquired: number | bigint | null }>
    >`SELECT GET_LOCK('welapathkade:referral-correction', 10) AS acquired`;
    const acquired = rows[0]?.acquired;
    if (acquired === null || Number(acquired) !== 1) {
      throw new ConflictException(
        'Could not acquire referral correction lock; retry',
      );
    }
  }

  private async releaseReferralCorrectionLock(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`SELECT RELEASE_LOCK('welapathkade:referral-correction')`;
  }

  private async lockUserRow(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT \`id\`
      FROM \`User\`
      WHERE \`id\` = ${userId}
      FOR UPDATE
    `;
  }

  private async assertEligiblePublicReferrer(
    tx: Prisma.TransactionClient,
    referrerUserId: string,
  ): Promise<void> {
    await this.lockUserRow(tx, referrerUserId);
    const referrer = await tx.user.findUnique({
      where: { id: referrerUserId },
      select: { id: true, role: true, status: true },
    });
    if (!referrer || referrer.role !== UserRole.PUBLIC) {
      throw new BadRequestException('Invalid referrer');
    }
    // Match registration eligibility: PUBLIC referrers may be ACTIVE/INACTIVE;
    // SUSPENDED referrers are rejected.
    if (referrer.status === UserStatus.SUSPENDED) {
      throw new BadRequestException('Invalid referrer');
    }
  }

  /**
   * Walk the prospective referrer's ancestry under row locks.
   * Detects direct and indirect cycles that would make target an ancestor.
   */
  private async assertNoReferralCycle(
    tx: Prisma.TransactionClient,
    targetUserId: string,
    newReferrerUserId: string,
  ): Promise<void> {
    let current: string | null = newReferrerUserId;
    const seen = new Set<string>();
    while (current) {
      if (current === targetUserId) {
        throw new BadRequestException('Referral cycle is not allowed');
      }
      if (seen.has(current)) {
        // Pre-existing cycle in the graph — refuse to extend it.
        throw new BadRequestException('Referral cycle is not allowed');
      }
      seen.add(current);
      await this.lockUserRow(tx, current);
      const row: { referredByUserId: string | null } | null =
        await tx.user.findUnique({
          where: { id: current },
          select: { referredByUserId: true },
        });
      current = row?.referredByUserId ?? null;
    }
  }

  assertCanAuthenticate(user: User): void {
    if (user.status === UserStatus.SUSPENDED) {
      throw new BadRequestException('Account is suspended');
    }
    if (user.status === UserStatus.INACTIVE) {
      throw new BadRequestException('Account is inactive');
    }
  }
}

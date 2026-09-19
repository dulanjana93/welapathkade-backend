import {
  BadRequestException,
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
import { generateReferralCode } from '../common/crypto/hashing';
import { hashPassword } from '../common/crypto/password';
import { PrismaService } from '../prisma/prisma.service';

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
  profileStatus?: AstrologerProfileStatus | null;
  applicationStatus?: AstrologerApplicationStatus | null;
  rejectionReason?: string | null;
};

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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

  assertCanAuthenticate(user: User): void {
    if (user.status === UserStatus.SUSPENDED) {
      throw new BadRequestException('Account is suspended');
    }
    if (user.status === UserStatus.INACTIVE) {
      throw new BadRequestException('Account is inactive');
    }
  }
}

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DevicePlatform, Language, OtpPurpose, User } from '@prisma/client';
import { normalizePhone } from '../common/phone/normalize-phone';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { SMS_SENDER, type SmsSender } from './interfaces/sms-sender.interface';

function isPublicRegistration(purpose: OtpPurpose): boolean {
  return (
    purpose === OtpPurpose.PUBLIC_REGISTRATION ||
    purpose === OtpPurpose.REGISTRATION
  );
}

function isAstrologerRegistration(purpose: OtpPurpose): boolean {
  return purpose === OtpPurpose.ASTROLOGER_REGISTRATION;
}

function isRegistrationPurpose(purpose: OtpPurpose): boolean {
  return isPublicRegistration(purpose) || isAstrologerRegistration(purpose);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
  ) {}

  async requestOtp(rawPhone: string, purpose?: OtpPurpose) {
    const phone = normalizePhone(rawPhone);
    const existing = await this.usersService.findByPhone(phone);

    if (existing) {
      this.usersService.assertCanAuthenticate(existing);
    }

    let resolvedPurpose = purpose;
    if (!resolvedPurpose) {
      resolvedPurpose = existing
        ? OtpPurpose.LOGIN
        : OtpPurpose.PUBLIC_REGISTRATION;
    }

    // Normalize legacy REGISTRATION to PUBLIC_REGISTRATION for storage.
    if (resolvedPurpose === OtpPurpose.REGISTRATION) {
      resolvedPurpose = OtpPurpose.PUBLIC_REGISTRATION;
    }

    if (isRegistrationPurpose(resolvedPurpose) && existing) {
      throw new ConflictException(
        'Phone number is already registered. Please log in instead.',
      );
    }

    if (resolvedPurpose === OtpPurpose.LOGIN && !existing) {
      throw new BadRequestException('No account found for this phone number');
    }

    if (resolvedPurpose === OtpPurpose.PHONE_CHANGE) {
      throw new BadRequestException('PHONE_CHANGE is not supported yet');
    }

    const result = await this.otpService.requestOtp({
      phone,
      purpose: resolvedPurpose,
      user: existing,
    });

    return {
      message: 'OTP sent',
      purpose: resolvedPurpose,
      expiresIn: result.expiresIn,
    };
  }

  async verifyOtp(params: {
    phone: string;
    code: string;
    name?: string;
    language?: Language;
    referralCode?: string;
    deviceId?: string;
    fcmToken?: string;
    platform?: DevicePlatform;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const phone = normalizePhone(params.phone);
    const existing = await this.usersService.findByPhone(phone);

    if (existing) {
      this.usersService.assertCanAuthenticate(existing);
    }

    // Purpose comes from the stored OTP record — not from client role claims.
    const verifiedOtp = await this.otpService.verifyOtp({
      phone,
      code: params.code,
    });
    const purpose = verifiedOtp.purpose;

    let user: User;

    if (purpose === OtpPurpose.LOGIN) {
      if (!existing) {
        throw new BadRequestException('No account found for this phone number');
      }
      user = existing;
      if (params.referralCode) {
        throw new BadRequestException(
          'Referral code cannot be changed after registration',
        );
      }
    } else if (isRegistrationPurpose(purpose)) {
      if (existing) {
        throw new ConflictException(
          'Phone number is already registered. Please log in instead.',
        );
      }
      if (!params.name?.trim()) {
        throw new BadRequestException('Name is required for registration');
      }

      let referredByUserId: string | null = null;
      if (params.referralCode?.trim()) {
        const referrer = await this.usersService.resolvePublicReferrer(
          params.referralCode.trim().toUpperCase(),
        );
        if (referrer.phone === phone) {
          throw new BadRequestException('Self-referral is not allowed');
        }
        referredByUserId = referrer.id;
      }

      if (isAstrologerRegistration(purpose)) {
        user = await this.usersService.createAstrologerWithOnboarding({
          phone,
          name: params.name,
          language: params.language,
          referredByUserId,
        });
      } else {
        user = await this.usersService.createPublicUser({
          phone,
          name: params.name,
          language: params.language,
          referredByUserId,
        });
      }
    } else {
      throw new BadRequestException('Unsupported OTP purpose');
    }

    const tokens = await this.tokenService.issueSession({
      user,
      deviceId: params.deviceId,
      ip: params.ip,
      userAgent: params.userAgent,
    });

    if (params.fcmToken && params.platform) {
      await this.upsertDevice({
        userId: user.id,
        fcmToken: params.fcmToken,
        platform: params.platform,
      });
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: await this.usersService.toAuthMeView(user),
    };
  }

  async refresh(params: {
    refreshToken: string;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const rotated = await this.tokenService.rotateRefreshToken(params);
    this.usersService.assertCanAuthenticate(rotated.user);

    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: rotated.expiresIn,
      user: await this.usersService.toAuthMeView(rotated.user),
    };
  }

  async logout(refreshToken: string): Promise<{ message: string }> {
    await this.tokenService.revokeRefreshToken(refreshToken);
    return { message: 'Logged out' };
  }

  async upsertDevice(params: {
    userId: string;
    fcmToken: string;
    platform: DevicePlatform;
  }) {
    return this.prisma.userDevice.upsert({
      where: { fcmToken: params.fcmToken },
      create: {
        userId: params.userId,
        fcmToken: params.fcmToken,
        platform: params.platform,
        lastSeenAt: new Date(),
      },
      update: {
        userId: params.userId,
        platform: params.platform,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Test/dev helper — never exposed via HTTP. */
  getDevOtp(phone: string): string | undefined {
    return this.smsSender.getLastCode?.(normalizePhone(phone));
  }
}

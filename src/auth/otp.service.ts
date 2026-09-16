import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpPurpose, OtpStatus, User } from '@prisma/client';
import { AUTH_CONSTANTS } from '../common/auth/auth.constants';
import {
  generateNumericOtp,
  hashOtpCode,
  safeEqualHex,
} from '../common/crypto/hashing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SMS_SENDER, type SmsSender } from './interfaces/sms-sender.interface';

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
  ) {}

  private otpSecret(): string {
    return this.configService.getOrThrow<string>('app.jwtAccessSecret');
  }

  async requestOtp(params: {
    phone: string;
    purpose: OtpPurpose;
    user?: User | null;
  }): Promise<{ expiresIn: number }> {
    await this.enforceRequestLimits(params.phone);

    await this.prisma.otpVerification.updateMany({
      where: {
        phone: params.phone,
        purpose: params.purpose,
        status: OtpStatus.PENDING,
      },
      data: { status: OtpStatus.EXPIRED },
    });

    const code = generateNumericOtp(AUTH_CONSTANTS.OTP_LENGTH);
    const codeHash = hashOtpCode(code, params.phone, this.otpSecret());
    const expiresAt = new Date(
      Date.now() + AUTH_CONSTANTS.OTP_TTL_SECONDS * 1000,
    );

    await this.prisma.otpVerification.create({
      data: {
        phone: params.phone,
        purpose: params.purpose,
        codeHash,
        status: OtpStatus.PENDING,
        expiresAt,
        userId: params.user?.id ?? null,
        attempts: 0,
      },
    });

    await this.smsSender.sendOtp({
      phone: params.phone,
      code,
      purpose: params.purpose,
    });

    await this.markRequest(params.phone);

    return { expiresIn: AUTH_CONSTANTS.OTP_TTL_SECONDS };
  }

  async verifyOtp(params: {
    phone: string;
    code: string;
    purpose?: OtpPurpose;
  }) {
    const otp = await this.prisma.otpVerification.findFirst({
      where: {
        phone: params.phone,
        status: OtpStatus.PENDING,
        ...(params.purpose ? { purpose: params.purpose } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      throw new BadRequestException('No pending OTP found for this phone');
    }

    if (otp.expiresAt.getTime() <= Date.now()) {
      await this.prisma.otpVerification.update({
        where: { id: otp.id },
        data: { status: OtpStatus.EXPIRED },
      });
      throw new BadRequestException('OTP has expired');
    }

    if (otp.attempts >= AUTH_CONSTANTS.OTP_MAX_ATTEMPTS) {
      await this.prisma.otpVerification.update({
        where: { id: otp.id },
        data: { status: OtpStatus.LOCKED },
      });
      throw new HttpException(
        'Too many invalid OTP attempts',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const expectedHash = hashOtpCode(
      params.code,
      params.phone,
      this.otpSecret(),
    );
    const matches = safeEqualHex(expectedHash, otp.codeHash);

    if (!matches) {
      const updated = await this.prisma.otpVerification.update({
        where: { id: otp.id },
        data: {
          attempts: { increment: 1 },
        },
      });

      if (updated.attempts >= AUTH_CONSTANTS.OTP_MAX_ATTEMPTS) {
        await this.prisma.otpVerification.update({
          where: { id: otp.id },
          data: { status: OtpStatus.LOCKED },
        });
        throw new HttpException(
          'Too many invalid OTP attempts',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new BadRequestException('Invalid OTP code');
    }

    const verified = await this.prisma.otpVerification.update({
      where: { id: otp.id },
      data: {
        status: OtpStatus.VERIFIED,
        verifiedAt: new Date(),
      },
    });

    return verified;
  }

  private async enforceRequestLimits(phone: string): Promise<void> {
    const redis = this.redisService.getClient();
    const cooldownKey = `otp:cooldown:${phone}`;
    const hourKey = `otp:hour:${phone}`;

    const cooldown = await redis.get(cooldownKey);
    if (cooldown) {
      throw new HttpException(
        'Please wait before requesting another OTP',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hourCount = Number((await redis.get(hourKey)) ?? '0');
    if (hourCount >= AUTH_CONSTANTS.OTP_REQUEST_MAX_PER_HOUR) {
      throw new HttpException(
        'OTP request limit exceeded. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async markRequest(phone: string): Promise<void> {
    const redis = this.redisService.getClient();
    const cooldownKey = `otp:cooldown:${phone}`;
    const hourKey = `otp:hour:${phone}`;

    await redis.set(
      cooldownKey,
      '1',
      'EX',
      AUTH_CONSTANTS.OTP_REQUEST_COOLDOWN_SECONDS,
    );

    const count = await redis.incr(hourKey);
    if (count === 1) {
      await redis.expire(hourKey, 60 * 60);
    }
  }
}

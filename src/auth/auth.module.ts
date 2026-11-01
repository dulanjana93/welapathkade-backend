import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { isNonProductionEnv } from '../config/runtime-safety';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_SENDER, type SmsSender } from './interfaces/sms-sender.interface';
import { OtpService } from './otp.service';
import { ConsoleSmsSender } from './providers/console-sms.sender';
import { NotifySmsSender } from './providers/notify-sms.sender';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenService } from './token.service';

const NOTIFY_LK_REQUIRED =
  'NOTIFY_LK_USER_ID, NOTIFY_LK_API_KEY, and NOTIFY_LK_SENDER_ID';

/**
 * Development and test keep the console sender. Every other environment uses
 * Notify.lk and refuses to boot until those settings exist. ConsoleSmsSender
 * is never selected outside development/test.
 */
export function selectSmsSender(
  nodeEnv: string | undefined,
  consoleSender: ConsoleSmsSender,
  notifySender?: NotifySmsSender,
): SmsSender {
  if (isNonProductionEnv(nodeEnv)) {
    return consoleSender;
  }
  if (!notifySender) {
    throw new Error(
      `Unsafe configuration: ${NOTIFY_LK_REQUIRED} must be set before deploying.`,
    );
  }
  return notifySender;
}

export function createNotifySmsSender(settings: {
  userId?: string;
  apiKey?: string;
  senderId?: string;
}): NotifySmsSender | undefined {
  const userId = blankToUndefined(settings.userId);
  const apiKey = blankToUndefined(settings.apiKey);
  const senderId = blankToUndefined(settings.senderId);
  if (!userId && !apiKey && !senderId) return undefined;
  if (!userId || !apiKey || !senderId) {
    throw new Error(
      `Unsafe configuration: ${NOTIFY_LK_REQUIRED} must all be set together.`,
    );
  }
  return new NotifySmsSender({ userId, apiKey, senderId });
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('app.jwtAccessSecret'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    TokenService,
    JwtStrategy,
    ConsoleSmsSender,
    {
      provide: SMS_SENDER,
      inject: [ConfigService, ConsoleSmsSender],
      useFactory: (
        config: ConfigService,
        consoleSender: ConsoleSmsSender,
      ): SmsSender =>
        selectSmsSender(
          config.get<string>('app.nodeEnv'),
          consoleSender,
          createNotifySmsSender({
            userId: config.get<string>('app.notifyLkUserId'),
            apiKey: config.get<string>('app.notifyLkApiKey'),
            senderId: config.get<string>('app.notifyLkSenderId'),
          }),
        ),
    },
  ],
  exports: [AuthService, TokenService, JwtModule, PassportModule],
})
export class AuthModule {}

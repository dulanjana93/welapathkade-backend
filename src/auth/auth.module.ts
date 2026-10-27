import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { assertDevOnlyProviderAllowed } from '../config/runtime-safety';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_SENDER, type SmsSender } from './interfaces/sms-sender.interface';
import { OtpService } from './otp.service';
import { ConsoleSmsSender } from './providers/console-sms.sender';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenService } from './token.service';

/**
 * Selects the SMS sender. The console sender logs plaintext OTPs and sends
 * nothing, so it is development-only: boot fails closed anywhere else until a
 * real SMS adapter is added here.
 */
export function selectSmsSender(
  nodeEnv: string | undefined,
  consoleSender: ConsoleSmsSender,
): SmsSender {
  assertDevOnlyProviderAllowed('SMS sender', 'ConsoleSmsSender', nodeEnv);
  return consoleSender;
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
        selectSmsSender(config.get<string>('app.nodeEnv'), consoleSender),
    },
  ],
  exports: [AuthService, TokenService, JwtModule, PassportModule],
})
export class AuthModule {}

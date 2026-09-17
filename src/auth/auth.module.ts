import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_SENDER } from './interfaces/sms-sender.interface';
import { OtpService } from './otp.service';
import { ConsoleSmsSender } from './providers/console-sms.sender';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenService } from './token.service';

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
      useExisting: ConsoleSmsSender,
    },
  ],
  exports: [AuthService, TokenService, JwtModule, PassportModule],
})
export class AuthModule {}

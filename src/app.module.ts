import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';
import { validateEnv } from './config/validate-env';
import { AdminModule } from './admin/admin.module';
import { AstrologersModule } from './astrologers/astrologers.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AvailabilityModule } from './availability/availability.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { ExpiryModule } from './expiry/expiry.module';
import { PaymentsModule } from './payments/payments.module';
import { SettlementModule } from './settlement/settlement.module';
import { EarningsModule } from './earnings/earnings.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionEvidenceModule } from './session-evidence/session-evidence.module';
import { ServicesModule } from './services/services.module';
import { UsersModule } from './users/users.module';
import { VideoModule } from './video/video.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    UsersModule,
    AuthModule,
    ServicesModule,
    AstrologersModule,
    AvailabilityModule,
    ConsultationsModule,
    PaymentsModule,
    SettlementModule,
    EarningsModule,
    WithdrawalsModule,
    SessionEvidenceModule,
    VideoModule,
    NotificationsModule,
    ExpiryModule,
    AdminModule,
    AuditModule,
  ],
})
export class AppModule {}

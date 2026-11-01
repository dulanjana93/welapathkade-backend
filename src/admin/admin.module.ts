import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { AdminServicesController } from './admin-services.controller';
import { AdminAstrologersController } from './admin-astrologers.controller';
import { AdminUsersController } from './admin-users.controller';
import { AstrologersModule } from '../astrologers/astrologers.module';
import { ServicesModule } from '../services/services.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminRefundsController } from './admin-refunds.controller';
import { AdminSavedCardChargesController } from './admin-saved-card-charges.controller';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    ServicesModule,
    AstrologersModule,
    WithdrawalsModule,
    PaymentsModule,
  ],
  controllers: [
    AdminAuthController,
    AdminUsersController,
    AdminServicesController,
    AdminAstrologersController,
    AdminFinanceController,
    AdminRefundsController,
    AdminSavedCardChargesController,
  ],
  providers: [AdminAuthService, AdminFinanceService],
})
export class AdminModule {}

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingProfileController } from './billing-profile.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule],
  controllers: [BillingProfileController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

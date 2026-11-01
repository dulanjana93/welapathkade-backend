import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AstrologerWithdrawalsController } from './astrologer-withdrawals.controller';
import { BankAccountCrypto } from './bank-account.crypto';
import { CustomerReferralPayoutsController } from './customer-referral-payouts.controller';
import { WithdrawalsService } from './withdrawals.service';

@Module({
  imports: [AuditModule],
  controllers: [
    AstrologerWithdrawalsController,
    CustomerReferralPayoutsController,
  ],
  providers: [BankAccountCrypto, WithdrawalsService],
  exports: [WithdrawalsService, BankAccountCrypto],
})
export class WithdrawalsModule {}

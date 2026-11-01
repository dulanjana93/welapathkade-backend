import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { PaymentsModule } from '../payments/payments.module';
import { SettlementModule } from '../settlement/settlement.module';
import { ExpirySweepRunner } from './expiry-sweep.runner';
import { ExpirySweepService } from './expiry-sweep.service';
import { SessionCompletionSweepService } from './session-completion-sweep.service';

/**
 * Background expiry of unpaid payment holds (30 min), unanswered consultation
 * requests (12 h), hard-end completion of IN_PROGRESS sessions, Phase A
 * financial snapshot creation after the 24h settlement hold, Phase B
 * ledger posting (RECORDED → POSTED), and PayHere refund initiation plus
 * retrieval reconciliation for unresolved refunds.
 * PrismaModule and ConfigModule are global.
 */
@Module({
  imports: [
    AvailabilityModule,
    ConsultationsModule,
    PaymentsModule,
    SettlementModule,
  ],
  providers: [
    SessionCompletionSweepService,
    ExpirySweepService,
    ExpirySweepRunner,
  ],
  exports: [
    SessionCompletionSweepService,
    ExpirySweepService,
    ExpirySweepRunner,
  ],
})
export class ExpiryModule {}

import { Module } from '@nestjs/common';
import { FinancialLedgerService } from './financial-ledger.service';
import { FinancialSnapshotService } from './financial-snapshot.service';

@Module({
  providers: [FinancialSnapshotService, FinancialLedgerService],
  exports: [FinancialSnapshotService, FinancialLedgerService],
})
export class SettlementModule {}

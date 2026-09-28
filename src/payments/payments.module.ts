import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { MockPaymentGateway } from './mock-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [AvailabilityModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    MockPaymentGateway,
    {
      provide: PAYMENT_GATEWAY,
      useExisting: MockPaymentGateway,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}

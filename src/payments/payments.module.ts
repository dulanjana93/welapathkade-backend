import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertDevOnlyProviderAllowed } from '../config/runtime-safety';
import { AvailabilityModule } from '../availability/availability.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { MockPaymentGateway } from './mock-payment.gateway';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Selects the payment gateway. The mock gateway cannot take real payments, so
 * boot fails closed outside development/test until a real gateway adapter is
 * added here.
 */
export function selectPaymentGateway(
  nodeEnv: string | undefined,
  mock: MockPaymentGateway,
): PaymentGateway {
  assertDevOnlyProviderAllowed(
    'payment gateway',
    'MockPaymentGateway',
    nodeEnv,
  );
  return mock;
}

@Module({
  imports: [AvailabilityModule, NotificationsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    AppointmentLifecycleService,
    MockPaymentGateway,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, MockPaymentGateway],
      useFactory: (
        config: ConfigService,
        mock: MockPaymentGateway,
      ): PaymentGateway =>
        selectPaymentGateway(config.get<string>('app.nodeEnv'), mock),
    },
  ],
  exports: [PaymentsService, AppointmentLifecycleService],
})
export class PaymentsModule {}

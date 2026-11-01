import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertDevOnlyProviderAllowed, isNonProductionEnv } from '../config/runtime-safety';
import { AvailabilityModule } from '../availability/availability.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettlementModule } from '../settlement/settlement.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { MockPaymentGateway } from './mock-payment.gateway';
import { PayHereGateway } from './payhere/payhere.gateway';
import { readPayHereSettings } from './payhere/payhere.settings';
import { PAYHERE_MERCHANT, PayHereRefundService } from './payhere-refund.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SavedCardChargeController } from './saved-card-charge.controller';
import { SavedCardChargeService } from './saved-card-charge.service';
import { SavedCardController } from './saved-card.controller';
import { SavedCardService } from './saved-card.service';

/**
 * Development and test keep the mock gateway unless PAYHERE_MODE=sandbox.
 * Production uses live PayHere, or sandbox only when that choice is explicit.
 * It never falls back to the mock gateway or across sandbox and live.
 */
export function selectPaymentGateway(
  nodeEnv: string | undefined,
  mode: string | undefined,
  mock: MockPaymentGateway,
  payhere?: PaymentGateway,
  allowProductionSandbox = false,
): PaymentGateway {
  if (!isNonProductionEnv(nodeEnv)) {
    if (mode === 'sandbox' && allowProductionSandbox) {
      if (!payhere || payhere.provider !== 'PAYHERE') {
        throw new Error(
          'Unsafe configuration: PAYHERE_MODE=sandbox requires PayHere settings.',
        );
      }
      return payhere;
    }
    if (mode !== 'live' || !payhere || payhere.provider !== 'PAYHERE') {
      throw new Error(
        'Unsafe configuration: MockPaymentGateway is a development-only payment gateway. Production requires PAYHERE_MODE=live.',
      );
    }
    return payhere;
  }
  if (mode === 'live') {
    throw new Error(
      'Unsafe configuration: PAYHERE_MODE=live is only allowed when NODE_ENV is production.',
    );
  }
  if (mode === 'sandbox') {
    if (!payhere || payhere.provider !== 'PAYHERE') {
      throw new Error(
        'Unsafe configuration: PAYHERE_MODE=sandbox requires PayHere settings.',
      );
    }
    return payhere;
  }
  assertDevOnlyProviderAllowed(
    'payment gateway',
    'MockPaymentGateway',
    nodeEnv,
  );
  return mock;
}

@Module({
  imports: [
    AvailabilityModule,
    NotificationsModule,
    SettlementModule,
    WithdrawalsModule,
  ],
  controllers: [
    PaymentsController,
    SavedCardController,
    SavedCardChargeController,
  ],
  providers: [
    PaymentsService,
    AppointmentLifecycleService,
    PayHereRefundService,
    SavedCardService,
    SavedCardChargeService,
    MockPaymentGateway,
    {
      provide: PAYHERE_MERCHANT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PayHereGateway | null => {
        const mode = config.get<string>('app.payhereMode');
        if (mode !== 'sandbox' && mode !== 'live') return null;
        return new PayHereGateway(readPayHereSettings(config));
      },
    },
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, MockPaymentGateway, PAYHERE_MERCHANT],
      useFactory: (
        config: ConfigService,
        mock: MockPaymentGateway,
        payhere: PayHereGateway | null,
      ): PaymentGateway => {
        const nodeEnv = config.get<string>('app.nodeEnv');
        const mode = config.get<string>('app.payhereMode');
        const allowProductionSandbox =
          config.get<string>('app.payhereAllowSandbox') === 'true';
        return selectPaymentGateway(
          nodeEnv,
          mode,
          mock,
          payhere ?? undefined,
          allowProductionSandbox,
        );
      },
    },
  ],
  exports: [
    PaymentsService,
    AppointmentLifecycleService,
    PayHereRefundService,
    SavedCardChargeService,
  ],
})
export class PaymentsModule {}

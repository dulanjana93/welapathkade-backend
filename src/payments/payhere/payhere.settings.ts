import { ConfigService } from '@nestjs/config';
import {
  officialPayHereUrls,
  type PayHereMode,
  type PayHereSettings,
} from './payhere.gateway';

export function readPayHereSettings(config: ConfigService): PayHereSettings {
  const mode = config.get<string>('app.payhereMode');
  if (mode !== 'sandbox' && mode !== 'live') {
    throw new Error(
      'Unsafe configuration: PAYHERE_MODE must be sandbox or live',
    );
  }
  const official = officialPayHereUrls(mode);
  return {
    mode,
    merchantId: required(config, 'app.payhereMerchantId', 'PAYHERE_MERCHANT_ID'),
    merchantSecret: required(
      config,
      'app.payhereMerchantSecret',
      'PAYHERE_MERCHANT_SECRET',
    ),
    checkoutUrl:
      config.get<string>('app.payhereCheckoutUrl') ?? official.checkoutUrl,
    oauthUrl: config.get<string>('app.payhereOauthUrl') ?? official.oauthUrl,
    retrievalUrl: official.retrievalUrl,
    refundUrl: official.refundUrl,
    preapprovalUrl: official.preapprovalUrl,
    chargeUrl: official.chargeUrl,
    appId: required(config, 'app.payhereAppId', 'PAYHERE_APP_ID'),
    appSecret: required(config, 'app.payhereAppSecret', 'PAYHERE_APP_SECRET'),
    notifyUrl: required(config, 'app.payhereNotifyUrl', 'PAYHERE_NOTIFY_URL'),
    returnUrl: required(config, 'app.payhereReturnUrl', 'PAYHERE_RETURN_URL'),
    cancelUrl: required(config, 'app.payhereCancelUrl', 'PAYHERE_CANCEL_URL'),
  };
}

function required(
  config: ConfigService,
  key: string,
  name: string,
): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(`Unsafe configuration: ${name} must be set`);
  }
  return value;
}

export type { PayHereMode };

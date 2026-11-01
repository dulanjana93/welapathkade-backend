import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  // No default: an unset NODE_ENV must not behave like development.
  nodeEnv: process.env.NODE_ENV,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  businessTimezone: process.env.BUSINESS_TIMEZONE ?? 'Asia/Colombo',
  bankAccountEncryptionKey: process.env.BANK_ACCOUNT_ENCRYPTION_KEY,
  notificationsFcmProvider: process.env.NOTIFICATIONS_FCM_PROVIDER,
  expirySweepEnabled: process.env.EXPIRY_SWEEP_ENABLED,
  expirySweepIntervalSeconds: process.env.EXPIRY_SWEEP_INTERVAL_SECONDS,
  agoraAppId: process.env.AGORA_APP_ID,
  agoraAppCertificate: process.env.AGORA_APP_CERTIFICATE,
  allowShortNoticeTestAppointments:
    process.env.ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS,
  notifyLkUserId: process.env.NOTIFY_LK_USER_ID,
  notifyLkApiKey: process.env.NOTIFY_LK_API_KEY,
  notifyLkSenderId: process.env.NOTIFY_LK_SENDER_ID,
  payhereMode: blank(process.env.PAYHERE_MODE)?.toLowerCase(),
  payhereAllowSandbox: blank(process.env.PAYHERE_ALLOW_SANDBOX)?.toLowerCase(),
  payhereMerchantId: blank(process.env.PAYHERE_MERCHANT_ID),
  payhereMerchantSecret: blank(process.env.PAYHERE_MERCHANT_SECRET),
  payhereCheckoutUrl: blank(process.env.PAYHERE_CHECKOUT_URL),
  payhereOauthUrl: blank(process.env.PAYHERE_OAUTH_URL),
  payhereAppId: blank(process.env.PAYHERE_APP_ID),
  payhereAppSecret: blank(process.env.PAYHERE_APP_SECRET),
  payhereNotifyUrl: blank(process.env.PAYHERE_NOTIFY_URL),
  payhereReturnUrl: blank(process.env.PAYHERE_RETURN_URL),
  payhereCancelUrl: blank(process.env.PAYHERE_CANCEL_URL),
}));

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

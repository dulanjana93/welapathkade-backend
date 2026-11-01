import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EnvironmentVariables, NodeEnv } from './env.validation';
import { assertShortNoticeTestAppointmentsEnv } from './short-notice-test-appointments';
import { BANK_ACCOUNT_ENCRYPTION_KEY_TEST_ONLY } from '../withdrawals/withdrawals.constants';

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const messages = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Environment validation failed: ${messages}`);
  }

  const hasAgoraId = validated.AGORA_APP_ID !== undefined;
  const hasAgoraCert = validated.AGORA_APP_CERTIFICATE !== undefined;
  if (hasAgoraId !== hasAgoraCert) {
    throw new Error(
      'Environment validation failed: AGORA_APP_ID and AGORA_APP_CERTIFICATE must both be set or both unset',
    );
  }

  assertShortNoticeTestAppointmentsEnv(
    validated.ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS,
    validated.NODE_ENV,
  );

  assertStorageEnv(validated);
  assertNotifyLkEnv(validated);
  assertPayHereEnv(validated);

  let decodedKey: Buffer;
  try {
    decodedKey = Buffer.from(validated.BANK_ACCOUNT_ENCRYPTION_KEY, 'base64');
  } catch {
    throw new Error(
      'Environment validation failed: BANK_ACCOUNT_ENCRYPTION_KEY must be base64',
    );
  }
  if (decodedKey.length !== 32) {
    throw new Error(
      'Environment validation failed: BANK_ACCOUNT_ENCRYPTION_KEY must decode to 32 bytes',
    );
  }
  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.BANK_ACCOUNT_ENCRYPTION_KEY ===
      BANK_ACCOUNT_ENCRYPTION_KEY_TEST_ONLY
  ) {
    throw new Error(
      'Environment validation failed: BANK_ACCOUNT_ENCRYPTION_KEY must not be the documented test key in production',
    );
  }

  return validated;
}

/**
 * Production must use the private S3-compatible bucket. The endpoint is the
 * account host only; the bucket is a separate setting and is never a path.
 * Cloudflare R2 signs with region `auto`.
 */
export function assertStorageEnv(validated: {
  NODE_ENV?: string;
  STORAGE_DRIVER?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}): void {
  const storageDriver = validated.STORAGE_DRIVER ?? 'local';
  if (validated.NODE_ENV === NodeEnv.Production && storageDriver !== 's3') {
    throw new Error(
      'Environment validation failed: STORAGE_DRIVER must be s3 in production',
    );
  }
  if (storageDriver !== 's3') {
    return;
  }
  const missing = [
    ['S3_ENDPOINT', validated.S3_ENDPOINT],
    ['S3_BUCKET', validated.S3_BUCKET],
    ['S3_ACCESS_KEY_ID', validated.S3_ACCESS_KEY_ID],
    ['S3_SECRET_ACCESS_KEY', validated.S3_SECRET_ACCESS_KEY],
  ].filter(([, value]) => value === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Environment validation failed: ${missing
        .map(([name]) => name)
        .join(', ')} must be set when STORAGE_DRIVER=s3`,
    );
  }
  if (validated.S3_REGION !== undefined && validated.S3_REGION !== 'auto') {
    throw new Error(
      'Environment validation failed: S3_REGION must be auto for Cloudflare R2',
    );
  }
  assertAccountEndpoint(validated.S3_ENDPOINT!);
}

const NOTIFY_LK_ENV_NAMES = [
  'NOTIFY_LK_USER_ID',
  'NOTIFY_LK_API_KEY',
  'NOTIFY_LK_SENDER_ID',
] as const;

/**
 * Production OTP delivery requires Notify.lk. Outside production the three
 * settings are optional, but a partial set is rejected so a half-configured
 * sender cannot boot. Error text names the variables only.
 */
export function assertNotifyLkEnv(validated: {
  NODE_ENV?: string;
  NOTIFY_LK_USER_ID?: string;
  NOTIFY_LK_API_KEY?: string;
  NOTIFY_LK_SENDER_ID?: string;
  NOTIFY_LK_ALLOW_DEMO_SENDER?: string;
  PAYHERE_MODE?: string;
  PAYHERE_ALLOW_SANDBOX?: string;
}): void {
  const missing = NOTIFY_LK_ENV_NAMES.filter(
    (name) => validated[name] === undefined,
  );
  const allowDemo = validated.NOTIFY_LK_ALLOW_DEMO_SENDER === 'true';
  const hostedSandbox =
    validated.NODE_ENV === NodeEnv.Production &&
    validated.PAYHERE_MODE === 'sandbox' &&
    validated.PAYHERE_ALLOW_SANDBOX === 'true';
  if (allowDemo && !hostedSandbox) {
    throw new Error(
      'Environment validation failed: NOTIFY_LK_ALLOW_DEMO_SENDER=true requires NODE_ENV=production, PAYHERE_MODE=sandbox, and PAYHERE_ALLOW_SANDBOX=true',
    );
  }
  if (validated.NODE_ENV === NodeEnv.Production) {
    if (missing.length > 0) {
      throw new Error(
        `Environment validation failed: ${missing.join(', ')} must be set in production`,
      );
    }
    if (validated.NOTIFY_LK_SENDER_ID === 'NotifyDEMO' && !allowDemo) {
      throw new Error(
        'Environment validation failed: NOTIFY_LK_SENDER_ID must be a sender ID approved by Notify.lk. NotifyDEMO cannot be used for production OTP delivery.',
      );
    }
    return;
  }
  if (missing.length > 0 && missing.length < NOTIFY_LK_ENV_NAMES.length) {
    throw new Error(
      `Environment validation failed: ${missing.join(', ')} must be set together with the other NOTIFY_LK settings`,
    );
  }
}

const PAYHERE_VALUE_NAMES = [
  'PAYHERE_MERCHANT_ID',
  'PAYHERE_MERCHANT_SECRET',
  'PAYHERE_APP_ID',
  'PAYHERE_APP_SECRET',
  'PAYHERE_NOTIFY_URL',
  'PAYHERE_RETURN_URL',
  'PAYHERE_CANCEL_URL',
] as const;

const PAYHERE_SANDBOX_CHECKOUT = 'https://sandbox.payhere.lk/pay/checkout';
const PAYHERE_LIVE_CHECKOUT = 'https://www.payhere.lk/pay/checkout';
const PAYHERE_SANDBOX_OAUTH =
  'https://sandbox.payhere.lk/merchant/v1/oauth/token';
const PAYHERE_LIVE_OAUTH = 'https://www.payhere.lk/merchant/v1/oauth/token';

/**
 * Production requires live PayHere unless sandbox is explicitly authorized.
 * Development and test stay on the mock gateway until PAYHERE_MODE=sandbox.
 * A partial set is rejected. Error text names variables only.
 */
export function assertPayHereEnv(validated: {
  NODE_ENV?: string;
  PAYHERE_MODE?: string;
  PAYHERE_ALLOW_SANDBOX?: string;
  PAYHERE_MERCHANT_ID?: string;
  PAYHERE_MERCHANT_SECRET?: string;
  PAYHERE_CHECKOUT_URL?: string;
  PAYHERE_OAUTH_URL?: string;
  PAYHERE_APP_ID?: string;
  PAYHERE_APP_SECRET?: string;
  PAYHERE_NOTIFY_URL?: string;
  PAYHERE_RETURN_URL?: string;
  PAYHERE_CANCEL_URL?: string;
}): void {
  const mode = validated.PAYHERE_MODE;
  const allowSandbox = validated.PAYHERE_ALLOW_SANDBOX === 'true';
  const anyValue =
    PAYHERE_VALUE_NAMES.some((name) => validated[name] !== undefined) ||
    validated.PAYHERE_CHECKOUT_URL !== undefined ||
    validated.PAYHERE_OAUTH_URL !== undefined;

  if (allowSandbox && mode !== 'sandbox') {
    throw new Error(
      'Environment validation failed: PAYHERE_ALLOW_SANDBOX=true requires PAYHERE_MODE=sandbox',
    );
  }

  if (validated.NODE_ENV === NodeEnv.Production) {
    if (mode === 'live') {
      assertPayHereValues(validated, 'live', true);
      return;
    }
    if (mode === 'sandbox' && allowSandbox) {
      assertPayHereValues(validated, 'sandbox', true);
      return;
    }
    if (mode === 'sandbox') {
      throw new Error(
        'Environment validation failed: PAYHERE_MODE=sandbox in production requires PAYHERE_ALLOW_SANDBOX=true',
      );
    }
    throw new Error(
      'Environment validation failed: PAYHERE_MODE must be live in production',
    );
  }

  if (mode === 'live') {
    throw new Error(
      'Environment validation failed: PAYHERE_MODE=live is only allowed in production',
    );
  }
  if (mode === undefined) {
    if (anyValue) {
      throw new Error(
        'Environment validation failed: PAYHERE_MODE must be sandbox or live when PayHere settings are present',
      );
    }
    return;
  }
  assertPayHereValues(validated, 'sandbox', false);
}

function assertPayHereValues(
  validated: {
    PAYHERE_MERCHANT_ID?: string;
    PAYHERE_MERCHANT_SECRET?: string;
    PAYHERE_CHECKOUT_URL?: string;
    PAYHERE_OAUTH_URL?: string;
    PAYHERE_APP_ID?: string;
    PAYHERE_APP_SECRET?: string;
    PAYHERE_NOTIFY_URL?: string;
    PAYHERE_RETURN_URL?: string;
    PAYHERE_CANCEL_URL?: string;
  },
  mode: 'sandbox' | 'live',
  production: boolean,
): void {
  const missing = PAYHERE_VALUE_NAMES.filter(
    (name) => validated[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Environment validation failed: ${missing.join(', ')} must be set when PAYHERE_MODE is ${mode}`,
    );
  }
  const checkout =
    mode === 'live' ? PAYHERE_LIVE_CHECKOUT : PAYHERE_SANDBOX_CHECKOUT;
  const oauth = mode === 'live' ? PAYHERE_LIVE_OAUTH : PAYHERE_SANDBOX_OAUTH;
  if (
    validated.PAYHERE_CHECKOUT_URL !== undefined &&
    validated.PAYHERE_CHECKOUT_URL !== checkout
  ) {
    throw new Error(
      `Environment validation failed: PAYHERE_CHECKOUT_URL must be ${checkout}`,
    );
  }
  if (
    validated.PAYHERE_OAUTH_URL !== undefined &&
    validated.PAYHERE_OAUTH_URL !== oauth
  ) {
    throw new Error(
      `Environment validation failed: PAYHERE_OAUTH_URL must be ${oauth}`,
    );
  }
  assertHttpsUrl('PAYHERE_NOTIFY_URL', validated.PAYHERE_NOTIFY_URL!, production);
  assertHttpsUrl('PAYHERE_RETURN_URL', validated.PAYHERE_RETURN_URL!, production);
  assertHttpsUrl('PAYHERE_CANCEL_URL', validated.PAYHERE_CANCEL_URL!, production);
}

function assertHttpsUrl(name: string, value: string, production: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `Environment validation failed: ${name} must be an https URL`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `Environment validation failed: ${name} must be an https URL`,
    );
  }
  if (
    production &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    throw new Error(
      `Environment validation failed: ${name} must not be a local address in production`,
    );
  }
}

function assertAccountEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      'Environment validation failed: S3_ENDPOINT must be an https URL',
    );
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(
      'Environment validation failed: S3_ENDPOINT must be an https URL without embedded credentials',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(
      'Environment validation failed: S3_ENDPOINT must not include a query or fragment',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      'Environment validation failed: S3_ENDPOINT must be the account endpoint without a bucket path',
    );
  }
}

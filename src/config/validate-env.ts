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

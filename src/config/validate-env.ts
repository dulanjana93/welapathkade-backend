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

  const storageDriver = validated.STORAGE_DRIVER ?? 'local';
  if (validated.NODE_ENV === NodeEnv.Production && storageDriver !== 's3') {
    throw new Error(
      'Environment validation failed: STORAGE_DRIVER must be s3 in production',
    );
  }
  if (storageDriver === 's3') {
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
  }

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

import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  /**
   * Required, with no default. Development-only integrations (mock payments,
   * console SMS/push, Swagger) are enabled only for `development`/`test`; an
   * unset value must never silently select them.
   */
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  BUSINESS_TIMEZONE!: string;

  /**
   * Required. Base64-encoded 32-byte key for AES-256-GCM bank account numbers.
   * Server only. Never log, return, or ship a production key in the repo.
   * The documented test key is rejected when NODE_ENV=production.
   */
  @IsString()
  @IsNotEmpty()
  BANK_ACCOUNT_ENCRYPTION_KEY!: string;

  /**
   * Optional. Push provider: console | noop. Defaults by NODE_ENV.
   * Trimmed and lower-cased before validation; empty/whitespace means unset.
   * Matches `resolveFcmProviderKind`, which normalizes the same way at runtime.
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
  })
  @IsOptional()
  @IsIn(['console', 'noop'])
  NOTIFICATIONS_FCM_PROVIDER?: string;

  /**
   * Optional. `true`/`false` turns the background expiry sweeper on/off.
   * Unset: on everywhere except NODE_ENV=test.
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  EXPIRY_SWEEP_ENABLED?: string;

  /** Optional. Seconds between sweeps, 5-3600. Unset: 60. */
  // Read the RAW value: implicit conversion would already have turned an
  // empty string into 0 before this runs.
  @Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'string' && raw.trim() === '') return undefined;
    return Number(raw);
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(3600)
  EXPIRY_SWEEP_INTERVAL_SECONDS?: number;

  /**
   * Optional until video is configured. Public Agora App ID (safe to return to
   * clients). Must be set together with AGORA_APP_CERTIFICATE.
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AGORA_APP_ID?: string;

  /**
   * Optional until video is configured. Server-only App Certificate.
   * Never expose in responses, logs, clients, or tests with real credentials.
   * Must be set together with AGORA_APP_ID.
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AGORA_APP_CERTIFICATE?: string;

  /**
   * Optional. Development/test-only: when `true`, proposal min lead is 5 minutes
   * instead of 60 so Agora video can be tested without waiting an hour.
   * Production startup rejects this flag when enabled (see validateEnv).
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS?: string;

  /**
   * `local` (dev/test disk) or `s3` (private Cloudflare R2). Production must
   * use `s3`. Unset means local outside production.
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsOptional()
  @IsIn(['local', 's3'])
  STORAGE_DRIVER?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_LOCAL_DIR?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_BUCKET?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  S3_ENDPOINT?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  S3_REGION?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  S3_BUCKET?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  S3_ACCESS_KEY_ID?: string;

  @Transform(({ value }: { value: unknown }) => trimToUndefined(value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  S3_SECRET_ACCESS_KEY?: string;

  @Transform(optionalInt)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ATTACHMENT_MAX_DOCUMENTS?: number;

  @Transform(optionalInt)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  ATTACHMENT_MAX_VOICE_NOTES?: number;

  @Transform(optionalInt)
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(10485760)
  ATTACHMENT_MAX_DOCUMENT_BYTES?: number;

  @Transform(optionalInt)
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(10485760)
  ATTACHMENT_MAX_VOICE_BYTES?: number;

  @Transform(optionalInt)
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(180)
  ATTACHMENT_MAX_VOICE_SECONDS?: number;

  @Transform(optionalInt)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  ATTACHMENT_ABANDONED_HOURS?: number;
}

function trimToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalInt({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}): number | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  return Number(raw);
}

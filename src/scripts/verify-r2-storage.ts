/**
 * Upload, read, and delete one private probe object in the configured R2 bucket.
 *
 * Usage (from welapathkade-api):
 *   npm run storage:verify
 *
 * Reads .env without overriding variables already set in the process.
 * Prints the bucket name and byte count only. Does not print credentials,
 * the endpoint, or the object key when the probe is removed.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { config as loadEnv } from 'dotenv';
import { validateEnv } from '../config/validate-env';
import { S3ObjectStorage } from '../storage/s3-object-storage';

const envFile = path.resolve(__dirname, '../../.env');
const loaded = loadEnv({ path: envFile, quiet: true });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Storage check failed';
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) =>
      secret.length > 0 ? current.split(secret).join('[redacted]') : current,
    text,
  );
}

async function main() {
  if (loaded.error && !process.env.STORAGE_DRIVER) {
    throw new Error(
      'Could not read welapathkade-api/.env. Run npm run storage:verify from welapathkade-api, or export STORAGE_DRIVER and the S3_* variables.',
    );
  }
  const env = validateEnv(process.env);
  if ((env.STORAGE_DRIVER ?? 'local') !== 's3') {
    throw new Error(
      'STORAGE_DRIVER must be s3. This check does not use local disk.',
    );
  }
  const secrets = [env.S3_ACCESS_KEY_ID ?? '', env.S3_SECRET_ACCESS_KEY ?? ''];
  const storage = new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION ?? 'auto',
    bucket: env.S3_BUCKET!,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  });
  const key = `consultations/unlinked/r2-verify/${randomUUID()}`;
  const body = Buffer.from(`welapathkade-r2-probe ${new Date().toISOString()}`);
  let uploaded = false;
  let failed = false;
  try {
    await storage.put(key, body, 'application/octet-stream');
    uploaded = true;
    const retrieved = await storage.get(key);
    if (!retrieved.equals(body)) {
      throw new Error('Retrieved bytes did not match the uploaded probe');
    }
    console.log(
      `R2 storage check passed (bucket=${storage.bucket}, bytes=${body.length})`,
    );
  } catch (error) {
    console.error(redact(messageOf(error), secrets));
    failed = true;
  }
  if (uploaded) {
    try {
      await storage.delete(key);
      console.log('Probe object deleted');
    } catch (error) {
      console.error(
        'Probe object could not be deleted. Remove it from the private bucket.',
      );
      console.error(`object key: ${key}`);
      console.error(redact(messageOf(error), secrets));
      failed = true;
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const secrets = [
    process.env.S3_ACCESS_KEY_ID ?? '',
    process.env.S3_SECRET_ACCESS_KEY ?? '',
  ];
  console.error(redact(messageOf(error), secrets));
  process.exit(1);
});

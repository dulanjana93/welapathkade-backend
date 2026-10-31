import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { FileProvider } from '@prisma/client';
import { assertSafeObjectKey, ObjectStorage } from './object-storage';

export type S3StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Private S3-compatible bucket (Cloudflare R2). No public URLs and no
 * presigned URLs are issued; authorized downloads are streamed by the API.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly provider = FileProvider.CLOUDFLARE_R2;
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // SDK defaults add CRC32 checksum headers. R2 does not implement them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertSafeObjectKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error('Empty object');
    }
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

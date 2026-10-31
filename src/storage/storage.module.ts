import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { LocalObjectStorage } from './local-object-storage';
import { OBJECT_STORAGE, ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ObjectStorage => {
        const driver = config.get<string>('STORAGE_DRIVER') ?? 'local';
        const bucket =
          config.get<string>('STORAGE_BUCKET') ?? 'private-consultations';
        if (driver === 's3') {
          return new S3ObjectStorage({
            endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
            region: config.get<string>('S3_REGION') ?? 'auto',
            bucket: config.getOrThrow<string>('S3_BUCKET'),
            accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
            secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
          });
        }
        const root =
          config.get<string>('STORAGE_LOCAL_DIR') ??
          path.join(process.cwd(), 'storage', 'private');
        return new LocalObjectStorage(root, bucket);
      },
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}

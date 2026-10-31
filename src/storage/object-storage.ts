import { FileProvider } from '@prisma/client';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface ObjectStorage {
  readonly provider: FileProvider;
  readonly bucket: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/**
 * Server-generated keys only. Rejects traversal and client-supplied paths.
 * Consultation uploads and profile pictures use separate prefixes.
 */
export function assertSafeObjectKey(key: string): void {
  if (
    !/^(?:consultations\/unlinked|profiles)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
      key,
    )
  ) {
    throw new Error('Invalid object key');
  }
}

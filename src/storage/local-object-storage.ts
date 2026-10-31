import { promises as fs } from 'fs';
import * as path from 'path';
import { FileProvider } from '@prisma/client';
import { assertSafeObjectKey, ObjectStorage } from './object-storage';

/**
 * Private files on local disk. Development and tests only.
 * The directory is not served as static content.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly provider = FileProvider.LOCAL;

  constructor(
    private readonly rootDir: string,
    readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer): Promise<void> {
    const filePath = this.resolve(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    assertSafeObjectKey(key);
    const root = path.resolve(this.rootDir);
    const filePath = path.resolve(root, ...key.split('/'));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      throw new Error('Invalid object key');
    }
    return filePath;
  }
}

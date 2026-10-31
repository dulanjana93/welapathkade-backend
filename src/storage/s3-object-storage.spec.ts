import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { FileProvider } from '@prisma/client';
import { S3ObjectStorage } from './s3-object-storage';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

const config = {
  endpoint: 'https://example.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'private-consultations',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
};

const key = 'consultations/unlinked/cust-1/file-1';

describe('S3ObjectStorage', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('configures a private path-style R2 client from the environment settings', () => {
    const storage = new S3ObjectStorage(config);
    expect(storage.provider).toBe(FileProvider.CLOUDFLARE_R2);
    expect(storage.bucket).toBe('private-consultations');
    expect(S3Client).toHaveBeenCalledWith({
      region: 'auto',
      endpoint: 'https://example.r2.cloudflarestorage.com',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  });

  it('uploads bytes without a public ACL', async () => {
    const storage = new S3ObjectStorage(config);
    const body = Buffer.from('png');
    mockSend.mockResolvedValueOnce({});
    await storage.put(key, body, 'image/png');
    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: 'private-consultations',
      Key: key,
      Body: body,
      ContentType: 'image/png',
    });
  });

  it('returns the stored bytes', async () => {
    const storage = new S3ObjectStorage(config);
    const body = Uint8Array.from(Buffer.from('voice'));
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(body) },
    });
    await expect(storage.get(key)).resolves.toEqual(Buffer.from(body));
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'private-consultations',
      Key: key,
    });
  });

  it('rejects an empty object', async () => {
    const storage = new S3ObjectStorage(config);
    mockSend.mockResolvedValueOnce({ Body: undefined });
    await expect(storage.get(key)).rejects.toThrow('Empty object');
  });

  it('deletes by bucket and key', async () => {
    const storage = new S3ObjectStorage(config);
    mockSend.mockResolvedValueOnce({});
    await storage.delete(key);
    expect(DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: 'private-consultations',
      Key: key,
    });
  });

  it('propagates storage failures for the caller to hide from clients', async () => {
    const storage = new S3ObjectStorage(config);
    mockSend.mockRejectedValue(new Error('AccessDenied'));
    await expect(
      storage.put(key, Buffer.from('x'), 'image/png'),
    ).rejects.toThrow('AccessDenied');
    await expect(storage.get(key)).rejects.toThrow('AccessDenied');
    await expect(storage.delete(key)).rejects.toThrow('AccessDenied');
  });

  it('does not call R2 for an unsafe object key', async () => {
    const storage = new S3ObjectStorage(config);
    await expect(
      storage.put('../secret', Buffer.from('x'), 'image/png'),
    ).rejects.toThrow('Invalid object key');
    await expect(storage.get('public/file')).rejects.toThrow(
      'Invalid object key',
    );
    await expect(storage.delete('consultations/linked/a/b')).rejects.toThrow(
      'Invalid object key',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

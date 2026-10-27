import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileProvider, FileStatus, UserRole } from '@prisma/client';
import { LocalObjectStorage } from '../storage/local-object-storage';
import { ObjectStorage } from '../storage/object-storage';
import { ConsultationAttachmentsService } from './consultation-attachments.service';

function png(): Buffer {
  const body = Buffer.alloc(16);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  return body;
}

class MemoryStorage implements ObjectStorage {
  readonly provider = FileProvider.LOCAL;
  readonly bucket = 'private-consultations';
  readonly objects = new Map<string, Buffer>();
  failPut = false;
  failDelete = false;

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (contentType.length === 0 || this.failPut) {
      return Promise.reject(new Error('storage down'));
    }
    this.objects.set(key, Buffer.from(body));
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) return Promise.reject(new Error('missing'));
    return Promise.resolve(found);
  }

  delete(key: string): Promise<void> {
    if (this.failDelete) return Promise.reject(new Error('delete failed'));
    this.objects.delete(key);
    return Promise.resolve();
  }
}

describe('ConsultationAttachmentsService', () => {
  const customer = { id: 'cust-1', role: UserRole.PUBLIC } as never;
  const otherCustomer = { id: 'cust-2', role: UserRole.PUBLIC } as never;
  const astrologer = { id: 'astro-user', role: UserRole.ASTROLOGER } as never;
  const otherAstrologer = {
    id: 'other-astro',
    role: UserRole.ASTROLOGER,
  } as never;
  const admin = { id: 'admin-1', role: UserRole.ADMIN } as never;

  function setup() {
    const storage = new MemoryStorage();
    const rows = new Map<string, Record<string, unknown>>();
    const prisma = {
      file: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          rows.set(data.id as string, data);
          return Promise.resolve(data);
        }),
        findMany: jest.fn(),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: { status: FileStatus };
          }) => {
            const row = rows.get(where.id);
            if (row) row.status = data.status;
            return Promise.resolve(row);
          },
        ),
      },
      consultationFile: {
        findFirst: jest.fn(),
      },
    };
    const service = new ConsultationAttachmentsService(
      prisma as never,
      storage,
    );
    return { service, storage, prisma, rows };
  }

  it('stores a png privately and returns an id without the object key', async () => {
    const { service, storage, rows } = setup();
    const uploaded = await service.upload(customer, 'IMAGE', {
      buffer: png(),
      originalname: 'folder/chart.png',
      mimetype: 'image/png',
    });
    expect(uploaded).toEqual({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      id: expect.any(String),
      kind: 'IMAGE',
      originalFilename: 'chart.png',
      mimeType: 'image/png',
      sizeBytes: 16,
      status: FileStatus.AVAILABLE,
    });
    expect(uploaded).not.toHaveProperty('objectKey');
    const stored = rows.get(uploaded.id) as { objectKey: string };
    expect(stored.objectKey).toBe(
      `consultations/unlinked/cust-1/${uploaded.id}`,
    );
    expect(stored.objectKey).not.toContain('chart.png');
    expect(storage.objects.get(stored.objectKey)).toEqual(png());
  });

  it('rejects a file whose bytes do not match the declared kind', async () => {
    const { service, storage } = setup();
    await expect(
      service.upload(customer, 'DOCUMENT', {
        buffer: png(),
        originalname: 'chart.png',
      }),
    ).rejects.toThrow(/not supported/);
    expect(storage.objects.size).toBe(0);
  });

  it('removes the object when the database row cannot be saved', async () => {
    const { service, storage, prisma } = setup();
    prisma.file.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.upload(customer, 'IMAGE', {
        buffer: png(),
        originalname: 'chart.png',
      }),
    ).rejects.toThrow(/could not be stored/);
    expect(storage.objects.size).toBe(0);
  });

  it('lets the owner and the assigned astrologer read a pending attachment', async () => {
    const { service, storage, prisma } = setup();
    const body = png();
    storage.objects.set('consultations/unlinked/cust-1/file-1', body);
    prisma.consultationFile.findFirst.mockResolvedValue({
      id: 'link-1',
      file: {
        status: FileStatus.AVAILABLE,
        mimeType: 'image/png',
        originalFilename: 'chart.png',
        objectKey: 'consultations/unlinked/cust-1/file-1',
      },
      consultation: {
        customerId: 'cust-1',
        status: 'PENDING',
        astrologer: { userId: 'astro-user' },
      },
    });

    const owner = await service.openContent(customer, 'con-1', 'link-1');
    const assigned = await service.openContent(astrologer, 'con-1', 'link-1');
    expect(owner.body).toEqual(body);
    expect(assigned.filename).toBe('chart.png');
  });

  it('hides the attachment from other customers, astrologers, and admins', async () => {
    const { service, storage, prisma } = setup();
    storage.objects.set('consultations/unlinked/cust-1/file-1', png());
    prisma.consultationFile.findFirst.mockResolvedValue({
      id: 'link-1',
      file: {
        status: FileStatus.AVAILABLE,
        mimeType: 'image/png',
        originalFilename: 'chart.png',
        objectKey: 'consultations/unlinked/cust-1/file-1',
      },
      consultation: {
        customerId: 'cust-1',
        status: 'PENDING',
        astrologer: { userId: 'astro-user' },
      },
    });
    const get = jest.spyOn(storage, 'get');
    await expect(
      service.openContent(otherCustomer, 'con-1', 'link-1'),
    ).rejects.toThrow(/not found/);
    await expect(
      service.openContent(otherAstrologer, 'con-1', 'link-1'),
    ).rejects.toThrow(/not found/);
    await expect(service.openContent(admin, 'con-1', 'link-1')).rejects.toThrow(
      /not found/,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('purges abandoned uploads and leaves linked files out of the query', async () => {
    const { service, storage, prisma, rows } = setup();
    rows.set('old', {
      id: 'old',
      objectKey: 'consultations/unlinked/cust-1/old',
      status: FileStatus.AVAILABLE,
    });
    storage.objects.set('consultations/unlinked/cust-1/old', png());
    prisma.file.findMany.mockResolvedValue([
      { id: 'old', objectKey: 'consultations/unlinked/cust-1/old' },
    ]);
    const removed = await service.purgeAbandonedUploads(
      new Date('2026-10-25T00:00:00.000Z'),
    );
    expect(removed).toBe(1);
    expect(storage.objects.size).toBe(0);
    expect(prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        where: expect.objectContaining({
          status: FileStatus.AVAILABLE,
          consultationFiles: { none: {} },
        }),
      }),
    );
    expect(prisma.file.update).toHaveBeenCalledWith({
      where: { id: 'old' },
      data: { status: FileStatus.DELETED },
    });
  });

  it('does not mark a file deleted when storage cleanup fails', async () => {
    const { service, storage, prisma } = setup();
    storage.failDelete = true;
    prisma.file.findMany.mockResolvedValue([
      { id: 'old', objectKey: 'consultations/unlinked/cust-1/old' },
    ]);
    await expect(service.purgeAbandonedUploads(new Date())).rejects.toThrow(
      /delete failed/,
    );
    expect(prisma.file.update).not.toHaveBeenCalled();
  });
});

describe('LocalObjectStorage', () => {
  it('refuses a key that leaves the private directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wela-storage-'));
    const storage = new LocalObjectStorage(dir, 'private-consultations');
    await expect(
      storage.put('../secret.txt', Buffer.from('no'), 'text/plain'),
    ).rejects.toThrow(/Invalid object key/);
    const escaped = path.join(dir, '..', 'secret.txt');
    await expect(fs.access(escaped)).rejects.toThrow();
  });
});

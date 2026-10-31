import { FileProvider, FileStatus, UserRole, UserStatus } from '@prisma/client';
import { assertSafeObjectKey, ObjectStorage } from '../storage/object-storage';
import { ProfilePicturesService } from './profile-pictures.service';

function jpeg(size = 16): Buffer {
  const body = Buffer.alloc(size);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  return body;
}

function png(): Buffer {
  const body = Buffer.alloc(16);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  return body;
}

function webp(): Buffer {
  const body = Buffer.alloc(16);
  Buffer.from('RIFF').copy(body, 0);
  Buffer.from('WEBP').copy(body, 8);
  return body;
}

class MemoryStorage implements ObjectStorage {
  readonly provider = FileProvider.LOCAL;
  readonly bucket = 'welapathkade';
  readonly objects = new Map<string, Buffer>();
  failPut = false;
  failDelete = false;

  put(key: string, body: Buffer): Promise<void> {
    return Promise.resolve().then(() => {
      assertSafeObjectKey(key);
      if (this.failPut) throw new Error('storage down');
      this.objects.set(key, Buffer.from(body));
    });
  }

  get(key: string): Promise<Buffer> {
    assertSafeObjectKey(key);
    const found = this.objects.get(key);
    if (!found) return Promise.reject(new Error('missing'));
    return Promise.resolve(found);
  }

  delete(key: string): Promise<void> {
    assertSafeObjectKey(key);
    if (this.failDelete) return Promise.reject(new Error('delete failed'));
    this.objects.delete(key);
    return Promise.resolve();
  }
}

function setup() {
  const storage = new MemoryStorage();
  const pointers = new Map<string, string | null>([
    ['cust-1', null],
    ['astro-1', null],
  ]);
  const files = new Map<string, Record<string, unknown>>();
  let loseNextClaim = false;
  const linkedConsultation = new Set<string>();

  const ownerOf = (fileId: string) => {
    for (const [userId, pointer] of pointers) {
      if (pointer === fileId) return { id: userId };
    }
    return null;
  };

  const prisma = {
    user: {
      findUnique: jest.fn(
        ({
          where,
          include,
        }: {
          where: { id: string };
          include?: { profilePicture?: boolean };
        }) => {
          if (!pointers.has(where.id)) return Promise.resolve(null);
          const profilePictureFileId = pointers.get(where.id) ?? null;
          const picture = profilePictureFileId
            ? (files.get(profilePictureFileId) ?? null)
            : null;
          return Promise.resolve({
            id: where.id,
            profilePictureFileId,
            profilePicture: include?.profilePicture ? picture : undefined,
          });
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; profilePictureFileId: string | null };
          data: { profilePictureFileId: string | null };
        }) => {
          if (!pointers.has(where.id)) return Promise.resolve({ count: 0 });
          if (where.profilePictureFileId !== pointers.get(where.id)) {
            return Promise.resolve({ count: 0 });
          }
          if (loseNextClaim) {
            loseNextClaim = false;
            return Promise.resolve({ count: 0 });
          }
          pointers.set(where.id, data.profilePictureFileId);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    file: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        files.set(data.id as string, { ...data });
        return Promise.resolve(data);
      }),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        files.delete(where.id);
        return Promise.resolve({});
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const file = files.get(where.id);
        if (!file) return Promise.resolve(null);
        return Promise.resolve({
          ...file,
          consultationFiles: linkedConsultation.has(where.id)
            ? [{ id: 'link' }]
            : [],
          profilePictureOwner: ownerOf(where.id),
        });
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status: FileStatus };
        }) => {
          const file = files.get(where.id);
          if (file) file.status = data.status;
          return Promise.resolve(file);
        },
      ),
    },
    astrologerProfile: { findFirst: jest.fn() },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  const service = new ProfilePicturesService(prisma as never, storage);
  return {
    service,
    storage,
    prisma,
    files,
    currentPointer: () => pointers.get('cust-1') ?? null,
    setPointer: (id: string | null) => {
      pointers.set('cust-1', id);
    },
    loseNextClaim: () => {
      loseNextClaim = true;
    },
    linkConsultation: (id: string) => linkedConsultation.add(id),
  };
}

const customer = {
  id: 'cust-1',
  role: UserRole.PUBLIC,
  status: UserStatus.ACTIVE,
} as never;
const astrologer = {
  id: 'astro-1',
  role: UserRole.ASTROLOGER,
  status: UserStatus.ACTIVE,
} as never;
const admin = {
  id: 'admin-1',
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
} as never;

describe('ProfilePicturesService', () => {
  it('stores a jpeg for the customer without exposing the object key', async () => {
    const { service, storage, files, currentPointer } = setup();
    const uploaded = await service.upload(customer, {
      buffer: jpeg(),
      originalname: 'folder/me.jpg',
      mimetype: 'image/jpeg',
    });
    expect(uploaded).toEqual({ hasProfilePicture: true });
    expect(uploaded).not.toHaveProperty('objectKey');
    const row = [...files.values()][0] as {
      id: string;
      objectKey: string;
      bucket: string;
      mimeType: string;
    };
    expect(row.objectKey).toBe(`profiles/cust-1/${row.id}`);
    expect(row.objectKey).not.toContain('me.jpg');
    expect(row.bucket).toBe('welapathkade');
    expect(row.mimeType).toBe('image/jpeg');
    expect(currentPointer()).toBe(row.id);
    expect(storage.objects.get(row.objectKey)).toEqual(jpeg());
  });

  it('stores png and webp for an astrologer', async () => {
    const { service } = setup();
    await service.upload(astrologer, {
      buffer: png(),
      originalname: 'face.png',
    });
    await service.upload(astrologer, {
      buffer: webp(),
      originalname: 'face.webp',
    });
  });

  it('rejects another role before writing storage', async () => {
    const { service, storage } = setup();
    await expect(
      service.upload(admin, { buffer: jpeg(), originalname: 'a.jpg' }),
    ).rejects.toThrow(/could not be changed/);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects a non-image and an extension that disagrees with the bytes', async () => {
    const { service, storage } = setup();
    const pdf = Buffer.from('%PDF-1.7');
    await expect(
      service.upload(customer, { buffer: pdf, originalname: 'a.jpg' }),
    ).rejects.toThrow(/not supported/);
    await expect(
      service.upload(customer, { buffer: jpeg(), originalname: 'a.gif' }),
    ).rejects.toThrow(/not supported/);
    await expect(
      service.upload(customer, {
        buffer: jpeg(),
        originalname: 'a.jpg',
        mimetype: 'image/png',
      }),
    ).rejects.toThrow(/does not match/);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects an image larger than 5 MB', async () => {
    const { service, storage } = setup();
    await expect(
      service.upload(customer, {
        buffer: jpeg(5 * 1024 * 1024 + 1),
        originalname: 'big.jpg',
      }),
    ).rejects.toThrow(/upload limit/);
    expect(storage.objects.size).toBe(0);
  });

  it('removes the new object when the database update fails', async () => {
    const { service, storage, prisma } = setup();
    prisma.file.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.upload(customer, { buffer: jpeg(), originalname: 'a.jpg' }),
    ).rejects.toThrow(/could not be stored/);
    expect(storage.objects.size).toBe(0);
  });

  it('removes the new object when the picture pointer was taken by another request', async () => {
    const { service, storage, files, loseNextClaim } = setup();
    loseNextClaim();
    await expect(
      service.upload(customer, { buffer: jpeg(), originalname: 'a.jpg' }),
    ).rejects.toThrow(/could not be stored/);
    expect(storage.objects.size).toBe(0);
    expect(files.size).toBe(0);
  });

  it('replaces a picture and deletes the previous object only after the pointer moves', async () => {
    const { service, storage, files, setPointer } = setup();
    const oldKey = 'profiles/cust-1/old-file';
    storage.objects.set(oldKey, jpeg());
    files.set('old-file', {
      id: 'old-file',
      objectKey: oldKey,
      status: FileStatus.AVAILABLE,
    });
    setPointer('old-file');
    await service.upload(customer, { buffer: png(), originalname: 'new.png' });
    expect(storage.objects.has(oldKey)).toBe(false);
    expect(files.get('old-file')?.status).toBe(FileStatus.DELETED);
    expect(storage.objects.size).toBe(1);
  });

  it('keeps a previous object that is still referenced', async () => {
    const { service, storage, files, setPointer, linkConsultation } = setup();
    const oldKey = 'profiles/cust-1/old-file';
    storage.objects.set(oldKey, jpeg());
    files.set('old-file', {
      id: 'old-file',
      objectKey: oldKey,
      status: FileStatus.AVAILABLE,
    });
    setPointer('old-file');
    linkConsultation('old-file');
    await service.upload(customer, { buffer: png(), originalname: 'new.png' });
    expect(storage.objects.has(oldKey)).toBe(true);
    expect(files.get('old-file')?.status).toBe(FileStatus.AVAILABLE);
  });

  it('leaves the new picture in place when deleting the old object fails', async () => {
    const { service, storage, files, setPointer } = setup();
    const oldKey = 'profiles/cust-1/old-file';
    files.set('old-file', {
      id: 'old-file',
      objectKey: oldKey,
      status: FileStatus.AVAILABLE,
    });
    setPointer('old-file');
    storage.failDelete = true;
    const uploaded = await service.upload(customer, {
      buffer: jpeg(),
      originalname: 'a.jpg',
    });
    expect(uploaded.hasProfilePicture).toBe(true);
    expect(files.get('old-file')?.status).toBe(FileStatus.AVAILABLE);
    storage.failDelete = false;
  });

  it('streams the owner picture and hides a missing one', async () => {
    const { service } = setup();
    const body = jpeg();
    await service.upload(customer, { buffer: body, originalname: 'a.jpg' });
    const opened = await service.openOwn(customer);
    expect(opened).toEqual({ body, mimeType: 'image/jpeg' });
    expect(opened).not.toHaveProperty('objectKey');
    await expect(service.openOwn(astrologer)).rejects.toThrow(/not found/);
  });

  it('removes the owner picture and restores the pointer if storage cleanup fails', async () => {
    const { service, storage, currentPointer } = setup();
    await service.upload(customer, { buffer: jpeg(), originalname: 'a.jpg' });
    storage.failDelete = true;
    await expect(service.remove(customer)).rejects.toThrow(
      /could not be removed/,
    );
    expect(currentPointer()).not.toBeNull();
    storage.failDelete = false;
    await expect(service.remove(customer)).resolves.toEqual({
      hasProfilePicture: false,
    });
    expect(currentPointer()).toBeNull();
    expect(storage.objects.size).toBe(0);
    await expect(service.remove(customer)).rejects.toThrow(/not found/);
  });

  it('streams a discoverable astrologer picture and hides everyone else', async () => {
    const { service, storage, prisma } = setup();
    const body = png();
    prisma.astrologerProfile.findFirst.mockResolvedValueOnce({
      user: {
        profilePicture: {
          objectKey: 'profiles/astro-1/pic',
          mimeType: 'image/png',
          status: FileStatus.AVAILABLE,
        },
      },
    });
    storage.objects.set('profiles/astro-1/pic', body);
    await expect(
      service.openDiscoverableAstrologer('profile-1'),
    ).resolves.toEqual({ body, mimeType: 'image/png' });
    prisma.astrologerProfile.findFirst.mockResolvedValueOnce(null);
    const get = jest.spyOn(storage, 'get');
    await expect(service.openDiscoverableAstrologer('missing')).rejects.toThrow(
      /not found/,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('does not call storage for an unsafe profile key', async () => {
    const storage = new MemoryStorage();
    await expect(
      storage.put('profiles/../secret', Buffer.from('x'), 'image/png'),
    ).rejects.toThrow(/Invalid object key/);
    expect(storage.objects.size).toBe(0);
  });
});

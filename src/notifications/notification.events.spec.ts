/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access -- jest mock idioms */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FcmProvider, FcmSendResult } from './fcm-provider.interface';
import { NotificationService } from './notification.service';

type Mock = jest.Mock;

function makePrisma() {
  return {
    notification: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    userDevice: { deleteMany: jest.fn() },
  };
}

const skipProvider: FcmProvider = {
  send: jest.fn(() => Promise.resolve<FcmSendResult>({ status: 'SKIPPED' })),
};

function makeService(prisma = makePrisma(), provider = skipProvider) {
  return {
    service: new NotificationService(prisma as never, provider),
    prisma,
  };
}

/** A transaction client with only what the event helpers touch. */
function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'n-created' }),
      findUnique: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    astrologerProfile: { findUnique: jest.fn() },
    ...overrides,
  };
}

const consultationRef = {
  type: 'CONSULTATION_ACCEPTED' as const,
  consultationId: 'c-1',
};

function createdData(tx: ReturnType<typeof makeTx>) {
  return (tx.notification.create as Mock).mock.calls[0][0].data as {
    userId: string;
    type: string;
    referenceId: string;
    title: string;
    body: string;
    data: Record<string, string>;
  };
}

describe('NotificationService.notifyUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the recipient language from the user row when none is given', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ language: 'EN' });

    const id = await service.notifyUser(tx as never, 'u-1', consultationRef);

    expect(id).toBe('n-created');
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      select: { language: true },
    });
    const data = createdData(tx);
    expect(data.userId).toBe('u-1');
    expect(data.type).toBe('CONSULTATION_ACCEPTED');
    expect(data.referenceId).toBe('c-1');
    expect(data.title).toBe('Request accepted');
  });

  it('uses a supplied language without querying the user', async () => {
    const { service } = makeService();
    const tx = makeTx();

    await service.notifyUser(tx as never, 'u-1', consultationRef, 'EN');

    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(createdData(tx).title).toBe('Request accepted');
  });

  it('defaults to Sinhala for a missing user, null or unsupported language', async () => {
    for (const language of [null, 'XX']) {
      const tx = makeTx();
      const { service } = makeService();
      await service.notifyUser(tx as never, 'u-1', consultationRef, language);
      expect(createdData(tx).title).toBe('ඉල්ලීම පිළිගෙන ඇත');
    }
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue(null);
    const { service } = makeService();
    await service.notifyUser(tx as never, 'u-1', consultationRef);
    expect(createdData(tx).title).toBe('ඉල්ලීම පිළිගෙන ඇත');
  });

  it('keys proposal events by proposal id and appointment events by appointment id, keeping the consultation id as navigation data', async () => {
    const { service } = makeService();

    const tx1 = makeTx();
    await service.notifyUser(
      tx1 as never,
      'u-1',
      { type: 'PROPOSAL_CREATED', consultationId: 'c-1', proposalId: 'p-9' },
      'EN',
    );
    expect(createdData(tx1).referenceId).toBe('p-9');
    expect(createdData(tx1).data).toEqual({
      type: 'PROPOSAL_CREATED',
      consultationId: 'c-1',
      proposalId: 'p-9',
      appointmentId: '',
    });

    const tx2 = makeTx();
    await service.notifyUser(
      tx2 as never,
      'u-1',
      {
        type: 'APPOINTMENT_CONFIRMED',
        consultationId: 'c-1',
        appointmentId: 'a-3',
      },
      'EN',
    );
    expect(createdData(tx2).referenceId).toBe('a-3');
    expect(createdData(tx2).data.appointmentId).toBe('a-3');
  });

  it('PROPOSAL_ACCEPTED text says payment is still pending, never confirmed', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.notifyUser(
      tx as never,
      'u-1',
      { type: 'PROPOSAL_ACCEPTED', consultationId: 'c-1', proposalId: 'p-1' },
      'EN',
    );
    expect(createdData(tx).body).toBe(
      'The customer accepted the proposed time. Payment is still pending.',
    );
  });

  it('returns null (not an id) for a duplicate, so nothing is delivered', async () => {
    const { service } = makeService();
    const tx = makeTx();
    (tx.notification.create as Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    (tx.notification.findUnique as Mock).mockResolvedValue({ id: 'existing' });

    await expect(
      service.notifyUser(tx as never, 'u-1', consultationRef, 'EN'),
    ).resolves.toBeNull();
  });

  it('returns null for an unreadable duplicate', async () => {
    const { service } = makeService();
    const tx = makeTx();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    (tx.notification.create as Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    (tx.notification.findUnique as Mock).mockResolvedValue(null);
    await expect(
      service.notifyUser(tx as never, 'u-1', consultationRef, 'EN'),
    ).resolves.toBeNull();
  });

  describe('InvalidNotificationError is tolerated, everything else propagates', () => {
    afterEach(() => jest.restoreAllMocks());

    it('swallows only the invalid-input error, with a safe warning', async () => {
      const lines: string[] = [];
      jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((m: unknown) => void lines.push(String(m)));
      const { service } = makeService();
      const tx = makeTx();

      // Missing proposalId reaches the service only through an unsafe cast.
      const id = await service.notifyUser(
        tx as never,
        'secret-user-id',
        { type: 'PROPOSAL_CREATED', consultationId: 'c-1' } as never,
        'EN',
      );

      expect(id).toBeNull();
      expect(tx.notification.create).not.toHaveBeenCalled();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('PROPOSAL_CREATED');
      expect(lines[0]).not.toContain('secret-user-id');
      expect(lines[0]).not.toContain('c-1');
    });

    it.each([
      ['database error', new Error('connection lost')],
      [
        'foreign-key error',
        new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      ],
      [
        'deadlock',
        new Prisma.PrismaClientKnownRequestError('deadlock', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      ],
    ])('rethrows a %s', async (_name, error) => {
      const { service } = makeService();
      const tx = makeTx();
      (tx.notification.create as Mock).mockRejectedValue(error);
      await expect(
        service.notifyUser(tx as never, 'u-1', consultationRef, 'EN'),
      ).rejects.toBe(error);
    });

    it('rethrows a failing language lookup', async () => {
      const { service } = makeService();
      const tx = makeTx();
      tx.user.findUnique.mockRejectedValue(new Error('read failed'));
      await expect(
        service.notifyUser(tx as never, 'u-1', consultationRef),
      ).rejects.toThrow('read failed');
    });
  });

  it('writes only through the supplied transaction client', async () => {
    const { service, prisma } = makeService();
    const tx = makeTx();
    await service.notifyUser(tx as never, 'u-1', consultationRef, 'EN');
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});

describe('NotificationService.notifyAstrologerProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves AstrologerProfile.userId and its language in one query on the transaction client', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.astrologerProfile.findUnique.mockResolvedValue({
      userId: 'astro-user-1',
      user: { language: 'EN' },
    });

    const id = await service.notifyAstrologerProfile(tx as never, 'ap-1', {
      type: 'PROPOSAL_REJECTED',
      consultationId: 'c-1',
      proposalId: 'p-1',
    });

    expect(id).toBe('n-created');
    expect(tx.astrologerProfile.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.astrologerProfile.findUnique).toHaveBeenCalledWith({
      where: { id: 'ap-1' },
      select: { userId: true, user: { select: { language: true } } },
    });
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    const data = createdData(tx);
    // Recipient is the user id, never the profile id.
    expect(data.userId).toBe('astro-user-1');
    expect(data.userId).not.toBe('ap-1');
    expect(data.referenceId).toBe('p-1');
    expect(data.title).toBe('Time proposal declined');
  });

  it('returns null and creates nothing when the profile does not exist', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.astrologerProfile.findUnique.mockResolvedValue(null);
    await expect(
      service.notifyAstrologerProfile(tx as never, 'ap-x', {
        type: 'APPOINTMENT_CONFIRMED',
        consultationId: 'c-1',
        appointmentId: 'a-1',
      }),
    ).resolves.toBeNull();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });
});

describe('NotificationService post-commit delivery tracking', () => {
  function deliveryFixture(sendImpl: () => Promise<FcmSendResult>) {
    const prisma = makePrisma();
    prisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      userId: 'u1',
      type: 'PROPOSAL_CREATED',
      title: 'T',
      body: 'B',
      data: { type: 'PROPOSAL_CREATED', consultationId: 'c1' },
      sentAt: null,
      attempts: 0,
      user: {
        status: 'ACTIVE',
        devices: [{ id: 'd1', fcmToken: 'tok-123456' }],
      },
    });
    prisma.userDevice.deleteMany.mockResolvedValue({ count: 0 });
    const provider = { send: jest.fn(sendImpl) };
    const { service } = makeService(prisma, provider);
    return { service, prisma, provider };
  }

  it('starts delivery without waiting for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, provider } = deliveryFixture(async () => {
      await gate;
      return { status: 'SENT' };
    });

    service.deliverAfterCommit(['n1']);
    // Returned synchronously while the provider is still waiting.
    await new Promise((r) => setImmediate(r));
    expect(provider.send).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flush = service.flushPending().then(() => (flushed = true));
    await new Promise((r) => setImmediate(r));
    expect(flushed).toBe(false);

    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it('ignores null, undefined and empty ids (duplicates and tolerated-invalid results)', async () => {
    const { service, provider, prisma } = deliveryFixture(async () => ({
      status: 'SENT',
    }));
    service.deliverAfterCommit([null, undefined, '']);
    await service.flushPending();
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('runs one delivery per id passed', async () => {
    const { service, provider } = deliveryFixture(async () => ({
      status: 'SENT',
    }));
    service.deliverAfterCommit(['n1', 'n1']);
    await service.flushPending();
    // Two ids were passed, two deliveries ran; callers pass each id once.
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('settles failures without unhandled rejections and never marks sentAt', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { service, prisma } = deliveryFixture(async () => {
        throw new Error('fcm exploded');
      });
      service.deliverAfterCommit(['n1']);
      await expect(service.flushPending()).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      jest.restoreAllMocks();
    }
  });

  it('a database failure during delivery is contained', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, prisma } = deliveryFixture(async () => ({
      status: 'SENT',
    }));
    prisma.notification.findUnique.mockRejectedValue(new Error('db down'));
    service.deliverAfterCommit(['n1']);
    await expect(service.flushPending()).resolves.toBeUndefined();
    jest.restoreAllMocks();
  });

  it('flushPending resolves immediately when nothing is pending and can be reused', async () => {
    const { service } = deliveryFixture(async () => ({ status: 'SENT' }));
    await expect(service.flushPending()).resolves.toBeUndefined();
    service.deliverAfterCommit(['n1']);
    await service.flushPending();
    service.deliverAfterCommit(['n1']);
    await service.flushPending();
  });

  it('onModuleDestroy waits for in-flight deliveries', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, provider } = deliveryFixture(async () => {
      await gate;
      return { status: 'SENT' };
    });
    service.deliverAfterCommit(['n1']);
    await new Promise((r) => setImmediate(r));

    let destroyed = false;
    const destroy = service.onModuleDestroy().then(() => (destroyed = true));
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(false);
    release();
    await destroy;
    expect(destroyed).toBe(true);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('does not retry automatically: a failed send is attempted once', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, provider } = deliveryFixture(async () => ({
      status: 'FAILED',
      invalidToken: false,
      retryable: true,
      error: 'UNAVAILABLE',
    }));
    service.deliverAfterCommit(['n1']);
    await service.flushPending();
    await new Promise((r) => setImmediate(r));
    expect(provider.send).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});

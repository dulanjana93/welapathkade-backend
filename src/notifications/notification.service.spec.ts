/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion -- jest mock idioms */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FcmProvider, FcmSendResult } from './fcm-provider.interface';
import {
  InvalidNotificationError,
  NotificationService,
  deriveReferenceId,
  type CreateNotificationInput,
} from './notification.service';

const text = {
  title: 'New appointment time',
  body: 'Open the app to review the proposed time.',
};

const proposalInput: CreateNotificationInput = {
  userId: 'user-1',
  type: 'PROPOSAL_CREATED',
  consultationId: 'consultation-1',
  proposalId: 'proposal-1',
  ...text,
};

function uniqueViolation(target?: unknown) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: 'test',
    meta: target === undefined ? undefined : { target },
  });
}

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

function makeService(provider: FcmProvider, prisma = makePrisma()) {
  const service = new NotificationService(prisma as never, provider);
  return { service, prisma };
}

const noProvider: FcmProvider = {
  send: jest.fn(() => Promise.resolve<FcmSendResult>({ status: 'SKIPPED' })),
};

describe('NotificationService.create: derived idempotency reference', () => {
  beforeEach(() => jest.clearAllMocks());

  type Case = {
    input: CreateNotificationInput;
    reference: string;
    data: Record<string, string>;
  };
  const cases: Case[] = [
    ...(
      [
        'CONSULTATION_REQUESTED',
        'CONSULTATION_ACCEPTED',
        'CONSULTATION_DECLINED',
      ] as const
    ).map((type) => ({
      input: {
        userId: 'u',
        type,
        consultationId: 'consultation-1',
        ...text,
      } as CreateNotificationInput,
      reference: 'consultation-1',
      data: {
        type,
        consultationId: 'consultation-1',
        proposalId: '',
        appointmentId: '',
      },
    })),
    ...(
      ['PROPOSAL_CREATED', 'PROPOSAL_ACCEPTED', 'PROPOSAL_REJECTED'] as const
    ).map((type) => ({
      input: {
        userId: 'u',
        type,
        consultationId: 'consultation-1',
        proposalId: 'proposal-9',
        ...text,
      } as CreateNotificationInput,
      reference: 'proposal-9',
      data: {
        type,
        consultationId: 'consultation-1',
        proposalId: 'proposal-9',
        appointmentId: '',
      },
    })),
    {
      input: {
        userId: 'u',
        type: 'APPOINTMENT_CONFIRMED',
        consultationId: 'consultation-1',
        appointmentId: 'appointment-7',
        ...text,
      },
      reference: 'appointment-7',
      data: {
        type: 'APPOINTMENT_CONFIRMED',
        consultationId: 'consultation-1',
        proposalId: '',
        appointmentId: 'appointment-7',
      },
    },
  ];

  it('covers all seven event types', () => {
    expect(new Set(cases.map((c) => c.input.type)).size).toBe(7);
  });

  it.each(cases)(
    '$input.type uses $reference as the idempotency reference',
    async ({ input, reference, data }) => {
      const { service, prisma } = makeService(noProvider);
      prisma.notification.create.mockResolvedValue({ id: 'n1' });

      const result = await service.create(input);

      expect(deriveReferenceId(input)).toBe(reference);
      expect(result).toEqual({
        status: 'CREATED',
        notification: { id: 'n1' },
      });
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: 'u',
          type: input.type,
          referenceId: reference,
          title: text.title,
          body: text.body,
          data,
        },
      });
    },
  );

  it('keeps the consultation id as navigation data, not as the reference, for proposals', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    await service.create(proposalInput);
    const arg = prisma.notification.create.mock.calls[0][0] as {
      data: { referenceId: string; data: Record<string, string> };
    };
    expect(arg.data.referenceId).toBe('proposal-1');
    expect(arg.data.data.consultationId).toBe('consultation-1');
  });

  it('two different proposals of one consultation each create their own notification', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create
      .mockResolvedValueOnce({ id: 'n-first' })
      .mockResolvedValueOnce({ id: 'n-second' });

    const first = await service.create({ ...proposalInput, proposalId: 'p-1' });
    const second = await service.create({
      ...proposalInput,
      proposalId: 'p-2',
    });

    expect(first).toEqual({
      status: 'CREATED',
      notification: { id: 'n-first' },
    });
    expect(second).toEqual({
      status: 'CREATED',
      notification: { id: 'n-second' },
    });
    const refs = prisma.notification.create.mock.calls.map(
      (c) => (c[0] as { data: { referenceId: string } }).data.referenceId,
    );
    expect(refs).toEqual(['p-1', 'p-2']);
    // Same consultation, same user, same type: only the proposal differs.
    const consultations = prisma.notification.create.mock.calls.map(
      (c) =>
        (c[0] as { data: { data: { consultationId: string } } }).data.data
          .consultationId,
    );
    expect(new Set(consultations)).toEqual(new Set(['consultation-1']));
  });

  it('the same proposal event twice is the duplicate case', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create.mockRejectedValue(uniqueViolation());
    prisma.notification.findUnique.mockResolvedValue({ id: 'existing' });
    const result = await service.create(proposalInput);
    expect(result).toEqual({
      status: 'DUPLICATE',
      notification: { id: 'existing' },
    });
  });

  describe('rejects missing or contradictory ids before any query', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      [
        'consultation event with proposalId',
        {
          type: 'CONSULTATION_ACCEPTED',
          consultationId: 'c',
          proposalId: 'p',
        },
      ],
      [
        'consultation event with appointmentId',
        {
          type: 'CONSULTATION_REQUESTED',
          consultationId: 'c',
          appointmentId: 'a',
        },
      ],
      [
        'proposal event without proposalId',
        {
          type: 'PROPOSAL_ACCEPTED',
          consultationId: 'c',
        },
      ],
      [
        'proposal event with empty proposalId',
        {
          type: 'PROPOSAL_REJECTED',
          consultationId: 'c',
          proposalId: ' ',
        },
      ],
      [
        'proposal event with appointmentId',
        {
          type: 'PROPOSAL_CREATED',
          consultationId: 'c',
          proposalId: 'p',
          appointmentId: 'a',
        },
      ],
      [
        'appointment event without appointmentId',
        {
          type: 'APPOINTMENT_CONFIRMED',
          consultationId: 'c',
        },
      ],
      [
        'appointment event with proposalId',
        {
          type: 'APPOINTMENT_CONFIRMED',
          consultationId: 'c',
          appointmentId: 'a',
          proposalId: 'p',
        },
      ],
      [
        'missing consultationId',
        {
          type: 'PROPOSAL_CREATED',
          proposalId: 'p',
        },
      ],
      [
        'unknown type',
        {
          type: 'SOMETHING_ELSE',
          consultationId: 'c',
        },
      ],
    ];

    it.each(bad)('%s', async (_name, fields) => {
      const { service, prisma } = makeService(noProvider);
      await expect(
        service.create({
          userId: 'u',
          ...text,
          ...fields,
        } as unknown as CreateNotificationInput),
      ).rejects.toBeInstanceOf(InvalidNotificationError);
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    });

    it('ignores a smuggled referenceId and uses the derived one', async () => {
      const { service, prisma } = makeService(noProvider);
      prisma.notification.create.mockResolvedValue({ id: 'n1' });
      await service.create({
        ...proposalInput,
        referenceId: 'consultation-1',
      } as unknown as CreateNotificationInput);
      const arg = prisma.notification.create.mock.calls[0][0] as {
        data: { referenceId: string };
      };
      expect(arg.data.referenceId).toBe('proposal-1');
    });
  });

  it.each([
    ['userId', { userId: '' }],
    ['title', { title: '' }],
    ['body', { body: '' }],
    ['long title', { title: 'x'.repeat(161) }],
    ['long body', { body: 'x'.repeat(501) }],
    ['control chars', { body: 'hi\u0000there' }],
  ])('rejects invalid input: %s', async (_name, override) => {
    const { service, prisma } = makeService(noProvider);
    await expect(
      service.create({ ...proposalInput, ...override }),
    ).rejects.toBeInstanceOf(InvalidNotificationError);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('rejects a reference id longer than the column', async () => {
    const { service, prisma } = makeService(noProvider);
    await expect(
      service.create({ ...proposalInput, proposalId: 'x'.repeat(192) }),
    ).rejects.toBeInstanceOf(InvalidNotificationError);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});

describe('NotificationService.create: transaction client', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the supplied transaction client and never the root client', async () => {
    const { service, prisma } = makeService(noProvider);
    const tx = {
      notification: { create: jest.fn().mockResolvedValue({ id: 'n-tx' }) },
    };
    const result = await service.create(proposalInput, tx as never);
    expect(result.status).toBe('CREATED');
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('does not open its own transaction', async () => {
    const prisma = { ...makePrisma(), $transaction: jest.fn() };
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    const { service } = makeService(noProvider, prisma as never);
    await service.create(proposalInput);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('NotificationService.create: duplicate handling', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the existing row for a duplicate', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create.mockRejectedValue(uniqueViolation());
    prisma.notification.findUnique.mockResolvedValue({ id: 'existing' });

    const result = await service.create(proposalInput);

    expect(result).toEqual({
      status: 'DUPLICATE',
      notification: { id: 'existing' },
    });
    expect(prisma.notification.findUnique).toHaveBeenCalledWith({
      where: {
        userId_type_referenceId: {
          userId: 'user-1',
          type: 'PROPOSAL_CREATED',
          referenceId: 'proposal-1',
        },
      },
    });
  });

  it('reads the existing row with the transaction client', async () => {
    const { service, prisma } = makeService(noProvider);
    const tx = {
      notification: {
        create: jest.fn().mockRejectedValue(uniqueViolation()),
        findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
      },
    };
    const result = await service.create(proposalInput, tx as never);
    expect(result.status).toBe('DUPLICATE');
    expect(tx.notification.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
  });

  it('a duplicate whose row is not readable is reported, not thrown, and not fabricated', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create.mockRejectedValue(uniqueViolation());
    prisma.notification.findUnique.mockResolvedValue(null);

    const result = await service.create(proposalInput);

    expect(result).toEqual({ status: 'DUPLICATE_UNREADABLE' });
    expect(result).not.toHaveProperty('notification');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('propagates a failure of the read-back itself', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create.mockRejectedValue(uniqueViolation());
    prisma.notification.findUnique.mockRejectedValue(new Error('read failed'));
    await expect(service.create(proposalInput)).rejects.toThrow('read failed');
  });

  it('accepts the Prisma target formats for the idempotency key', async () => {
    for (const target of [
      'Notification_userId_type_referenceId_key',
      ['userId', 'type', 'referenceId'],
      undefined,
    ]) {
      const { service, prisma } = makeService(noProvider);
      prisma.notification.create.mockRejectedValue(uniqueViolation(target));
      prisma.notification.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.create(proposalInput)).resolves.toMatchObject({
        status: 'DUPLICATE',
      });
    }
  });

  it.each([
    [
      'a conflict on another unique key',
      uniqueViolation('Notification_other_key'),
    ],
    [
      'a foreign-key failure',
      new Prisma.PrismaClientKnownRequestError('FK', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    ],
    ['a connection failure', new Error('db down')],
  ])('rethrows %s without reading back', async (_name, error) => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.create.mockRejectedValue(error);
    await expect(service.create(proposalInput)).rejects.toBe(error);
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
  });
});

describe('NotificationService.deliver', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'n1',
    userId: 'user-1',
    type: 'PROPOSAL_CREATED',
    title: 'T',
    body: 'B',
    data: { type: 'PROPOSAL_CREATED', consultationId: 'c1' },
    sentAt: null,
    attempts: 0,
    user: {
      status: 'ACTIVE',
      devices: [
        { id: 'd1', fcmToken: 'tokentokentoken-AAAAAA' },
        { id: 'd2', fcmToken: 'tokentokentoken-BBBBBB' },
      ],
    },
    ...overrides,
  });

  let warn: jest.SpyInstance;
  let logged: string[];
  beforeEach(() => {
    jest.clearAllMocks();
    logged = [];
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => void logged.push(String(m)));
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m: unknown) => void logged.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  it('marks sentAt and counts one attempt when the provider accepts', async () => {
    const provider = {
      send: jest.fn(async () => ({ status: 'SENT' }) as FcmSendResult),
    };
    const { service, prisma } = makeService(provider);
    prisma.notification.findUnique.mockResolvedValue(row());
    prisma.userDevice.deleteMany.mockResolvedValue({ count: 0 });

    const outcome = await service.deliver('n1');

    expect(outcome).toEqual({
      status: 'COMPLETED',
      sent: 2,
      skipped: 0,
      failed: 0,
      invalidTokensRemoved: 0,
    });
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', sentAt: null },
      data: { sentAt: expect.any(Date) },
    });
  });

  it('never marks sentAt or counts attempts when the provider skips', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.findUnique.mockResolvedValue(row());

    const outcome = await service.deliver('n1');

    expect(outcome).toMatchObject({ status: 'COMPLETED', skipped: 2, sent: 0 });
    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it('counts an attempt but never sets sentAt when every send fails', async () => {
    const provider = {
      send: jest.fn(
        async () =>
          ({
            status: 'FAILED',
            invalidToken: false,
            retryable: true,
            error: 'UNAVAILABLE',
          }) as FcmSendResult,
      ),
    };
    const { service, prisma } = makeService(provider);
    prisma.notification.findUnique.mockResolvedValue(row());

    const outcome = await service.deliver('n1');

    expect(outcome).toMatchObject({ failed: 2, sent: 0 });
    expect(prisma.notification.update).toHaveBeenCalledTimes(1);
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it('sets sentAt if at least one device succeeds and removes invalid tokens', async () => {
    const provider = {
      send: jest
        .fn()
        .mockResolvedValueOnce({ status: 'SENT' })
        .mockResolvedValueOnce({
          status: 'FAILED',
          invalidToken: true,
          retryable: false,
          error: 'UNREGISTERED',
        }),
    };
    const { service, prisma } = makeService(provider);
    prisma.notification.findUnique.mockResolvedValue(row());
    prisma.userDevice.deleteMany.mockResolvedValue({ count: 1 });

    const outcome = await service.deliver('n1');

    expect(outcome).toEqual({
      status: 'COMPLETED',
      sent: 1,
      skipped: 0,
      failed: 1,
      invalidTokensRemoved: 1,
    });
    expect(prisma.userDevice.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['d2'] }, userId: 'user-1' },
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not delete devices for non-token failures', async () => {
    const provider = {
      send: jest.fn(async () => ({
        status: 'FAILED' as const,
        invalidToken: false,
        retryable: false,
        error: 'INVALID_ARGUMENT',
      })),
    };
    const { service, prisma } = makeService(provider);
    prisma.notification.findUnique.mockResolvedValue(row());
    await service.deliver('n1');
    expect(prisma.userDevice.deleteMany).not.toHaveBeenCalled();
  });

  it('turns a throwing provider into a failed send, never an exception', async () => {
    const provider = {
      send: jest.fn(async () => {
        throw new Error('boom tokentokentoken-AAAAAA');
      }),
    };
    const { service, prisma } = makeService(provider);
    prisma.notification.findUnique.mockResolvedValue(row());

    const outcome = await service.deliver('n1');

    expect(outcome).toMatchObject({ status: 'COMPLETED', failed: 2, sent: 0 });
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it('never throws on database errors', async () => {
    const { service, prisma } = makeService(noProvider);
    prisma.notification.findUnique.mockRejectedValue(new Error('db down'));
    await expect(service.deliver('n1')).resolves.toEqual({ status: 'ERROR' });
  });

  it('short-circuits for missing, already sent, inactive and device-less cases', async () => {
    const provider = { send: jest.fn() };
    const { service, prisma } = makeService(provider);

    prisma.notification.findUnique.mockResolvedValueOnce(null);
    await expect(service.deliver('x')).resolves.toEqual({
      status: 'NOT_FOUND',
    });

    prisma.notification.findUnique.mockResolvedValueOnce(
      row({ sentAt: new Date() }),
    );
    await expect(service.deliver('n1')).resolves.toEqual({
      status: 'ALREADY_SENT',
    });

    prisma.notification.findUnique.mockResolvedValueOnce(
      row({
        user: { status: 'SUSPENDED', devices: [{ id: 'd', fcmToken: 't' }] },
      }),
    );
    await expect(service.deliver('n1')).resolves.toEqual({
      status: 'RECIPIENT_INACTIVE',
    });

    prisma.notification.findUnique.mockResolvedValueOnce(
      row({ user: { status: 'ACTIVE', devices: [] } }),
    );
    await expect(service.deliver('n1')).resolves.toEqual({
      status: 'NO_DEVICES',
    });

    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('never logs a full FCM token', async () => {
    const provider = {
      send: jest.fn(async () => ({
        status: 'FAILED' as const,
        invalidToken: false,
        retryable: true,
        error: 'UNAVAILABLE',
      })),
    };
    const { service, prisma } = makeService(provider);
    prisma.notification.findUnique.mockResolvedValue(row());

    await service.deliver('n1');

    expect(warn).toHaveBeenCalled();
    const output = logged.join('\n');
    expect(output).not.toContain('tokentokentoken-AAAAAA');
    expect(output).toContain('AAAAAA');
  });
});

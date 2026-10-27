import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  ConsultationFileType,
  ConsultationStatus,
  ServiceStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  CONSULTATION_IDEMPOTENCY_CONFLICT,
  consultationRequestFingerprint,
} from './consultation-idempotency';
import { ConsultationsService } from './consultations.service';
import { CONSULTATION_RESPONSE_TIMEOUT_HOURS } from './consultation.constants';

describe('ConsultationsService', () => {
  const prisma = {
    astrologerProfile: { findUnique: jest.fn() },
    service: { findUnique: jest.fn() },
    astrologerService: { findUnique: jest.fn() },
    file: { findMany: jest.fn() },
    consultation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    consultationFile: { createMany: jest.fn() },
    $transaction: jest.fn(),
  };

  const availability = {
    assertPreferredSlotEligible: jest.fn(),
  };

  const proposals = {
    loadProposalSummary: jest.fn().mockResolvedValue({
      proposals: [],
      pendingProposal: null,
      acceptedProposal: null,
    }),
    loadProposalSummaries: jest.fn().mockResolvedValue(new Map()),
  };

  const payments = {
    getSummaryForCustomer: jest.fn().mockResolvedValue(null),
    getSummaryForAstrologer: jest.fn().mockResolvedValue(null),
    listLatestAppointmentViews: jest.fn().mockResolvedValue(new Map()),
  };

  const notifications = {
    notifyUser: jest.fn().mockResolvedValue('n-1'),
    deliverAfterCommit: jest.fn(),
  };

  const followUp = {
    buildFollowUpView: jest.fn().mockResolvedValue({
      available: false,
      isOpen: false,
      expiresAt: null,
      customerMessagesSent: 0,
      customerMessagesRemaining: 5,
      canSend: false,
    }),
  };

  const reviews = {
    buildDetailExtras: jest.fn().mockResolvedValue({
      myReview: null,
      canSubmitReview: false,
      canEditReview: false,
    }),
  };

  const service = new ConsultationsService(
    prisma as never,
    availability as never,
    proposals as never,
    payments as never,
    notifications as never,
    followUp as never,
    reviews as never,
  );

  const publicUser = {
    id: 'cust-1',
    role: UserRole.PUBLIC,
    status: UserStatus.ACTIVE,
  } as never;

  const astroUser = {
    id: 'astro-user-1',
    role: UserRole.ASTROLOGER,
    status: UserStatus.ACTIVE,
  } as never;

  // Records the transaction client handed to the callback and whether the
  // transaction had completed (committed) at a given moment.
  const txUsed: { current: unknown; committed: boolean } = {
    current: undefined,
    committed: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Real Prisma always returns { count }; the expiry helper reads it.
    prisma.consultation.updateMany.mockResolvedValue({ count: 0 });
    txUsed.current = undefined;
    txUsed.committed = false;
  });

  /** Tx whose guarded updateMany affects `count` rows. */
  function mockRespondTx(count: number) {
    const tx = {
      consultation: { updateMany: jest.fn().mockResolvedValue({ count }) },
    };
    prisma.$transaction.mockImplementation(
      async (fn: (t: unknown) => unknown) => {
        txUsed.current = tx;
        const result = await fn(tx);
        txUsed.committed = true;
        return result;
      },
    );
    return tx;
  }

  function mockHappyPathCreate() {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      userId: 'astro-user-1',
      status: AstrologerProfileStatus.ACTIVE,
      isOnline: true,
      user: { status: UserStatus.ACTIVE, language: 'EN' },
    });
    prisma.service.findUnique.mockResolvedValue({
      id: 'svc-1',
      status: ServiceStatus.ACTIVE,
      nameSi: 'කේන්දර',
      nameEn: 'Horoscope',
    });
    prisma.astrologerService.findUnique.mockResolvedValue({
      id: 'as-1',
      status: AstrologerServiceStatus.ACTIVE,
      price: new Prisma.Decimal('1500.00'),
    });
    availability.assertPreferredSlotEligible.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const tx = {
          consultation: {
            create: jest.fn().mockResolvedValue({
              id: 'c-1',
              customerId: 'cust-1',
              status: ConsultationStatus.PENDING,
            }),
          },
          consultationFile: { createMany: jest.fn() },
        };
        txUsed.current = tx;
        const result = await fn(tx);
        txUsed.committed = true;
        return result;
      },
    );
    prisma.consultation.findUnique.mockResolvedValue({
      id: 'c-1',
      customerId: 'cust-1',
      status: ConsultationStatus.PENDING,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    prisma.consultation.findUniqueOrThrow.mockResolvedValue({
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      astrologerServiceId: 'as-1',
      serviceId: 'svc-1',
      status: ConsultationStatus.PENDING,
      requestedPrice: new Prisma.Decimal('1500.00'),
      serviceNameSi: 'කේන්දර',
      serviceNameEn: 'Horoscope',
      message: null,
      preferredStartAt: new Date('2026-09-20T04:30:00.000Z'),
      preferredEndAt: null,
      submittedAt: new Date('2026-09-19T10:00:00.000Z'),
      viewedAt: null,
      respondedAt: null,
      expiresAt: new Date('2026-09-19T22:00:00.000Z'),
      declineReason: null,
      astrologer: { id: 'ap-1', displayName: 'Nimal' },
      files: [],
    });
  }

  it('rejects non-PUBLIC creators', async () => {
    await expect(
      service.create(astroUser, {
        astrologerId: 'ap-1',
        serviceId: 'svc-1',
        preferredStartAt: '2026-09-20T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects inactive / suspended astrologer', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      status: AstrologerProfileStatus.SUSPENDED,
      user: { status: UserStatus.ACTIVE },
    });
    await expect(
      service.create(publicUser, {
        astrologerId: 'ap-1',
        serviceId: 'svc-1',
        preferredStartAt: '2026-09-20T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      status: AstrologerProfileStatus.INACTIVE,
      user: { status: UserStatus.ACTIVE },
    });
    await expect(
      service.create(publicUser, {
        astrologerId: 'ap-1',
        serviceId: 'svc-1',
        preferredStartAt: '2026-09-20T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects new requests when astrologer is Offline', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      status: AstrologerProfileStatus.ACTIVE,
      isOnline: false,
      user: { status: UserStatus.ACTIVE },
    });
    await expect(
      service.create(publicUser, {
        astrologerId: 'ap-1',
        serviceId: 'svc-1',
        preferredStartAt: '2026-09-20T04:30:00.000Z',
      }),
    ).rejects.toThrow('Astrologer is offline and not accepting new requests');
  });

  it('rejects inactive service and unoffered service', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      status: AstrologerProfileStatus.ACTIVE,
      isOnline: true,
      user: { status: UserStatus.ACTIVE },
    });
    prisma.service.findUnique.mockResolvedValue({
      id: 'svc-1',
      status: ServiceStatus.INACTIVE,
      nameSi: 'x',
      nameEn: 'x',
    });
    await expect(
      service.create(publicUser, {
        astrologerId: 'ap-1',
        serviceId: 'svc-1',
        preferredStartAt: '2026-09-20T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.service.findUnique.mockResolvedValue({
      id: 'svc-1',
      status: ServiceStatus.ACTIVE,
      nameSi: 'x',
      nameEn: 'x',
    });
    prisma.astrologerService.findUnique.mockResolvedValue(null);
    await expect(
      service.create(publicUser, {
        astrologerId: 'ap-1',
        serviceId: 'svc-1',
        preferredStartAt: '2026-09-20T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates PENDING with 12h expiresAt and price/name snapshot', async () => {
    mockHappyPathCreate();
    const fixed = new Date('2026-09-19T10:00:00.000Z');
    jest.useFakeTimers({ now: fixed });

    const result = await service.create(publicUser, {
      astrologerId: 'ap-1',
      serviceId: 'svc-1',
      preferredStartAt: '2026-09-20T04:30:00.000Z',
    });

    expect(availability.assertPreferredSlotEligible).toHaveBeenCalled();
    const createArg = (
      prisma.$transaction.mock.calls as unknown[][]
    )[0][0] as (tx: {
      consultation: { create: jest.Mock };
    }) => Promise<unknown>;
    // Exercise transaction callback path via mock implementation already done.
    expect(result.status).toBe(ConsultationStatus.PENDING);
    expect(result.requestedPrice).toBe('1500.00');
    expect(result.serviceNameEn).toBe('Horoscope');
    expect(result.viewedAt).toBeNull();

    const expectedExpiry = new Date(
      fixed.getTime() + CONSULTATION_RESPONSE_TIMEOUT_HOURS * 3600_000,
    );
    expect(result.expiresAt).toBe(expectedExpiry.toISOString());

    jest.useRealTimers();
    void createArg;
  });

  it('accepts PENDING and rejects expired', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      userId: 'astro-user-1',
    });
    const pending = {
      id: 'c-1',
      astrologerId: 'ap-1',
      status: ConsultationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
    };
    prisma.consultation.findUnique.mockResolvedValue(pending);
    mockRespondTx(1);
    prisma.consultation.findUniqueOrThrow.mockResolvedValue({
      ...pending,
      status: ConsultationStatus.ACCEPTED,
      customerId: 'cust-1',
      astrologerServiceId: 'as-1',
      serviceId: 'svc-1',
      requestedPrice: new Prisma.Decimal('1000'),
      serviceNameSi: 'a',
      serviceNameEn: 'b',
      message: null,
      preferredStartAt: new Date(),
      preferredEndAt: null,
      submittedAt: new Date(),
      viewedAt: null,
      respondedAt: new Date(),
      declineReason: null,
      customer: { id: 'cust-1', name: 'C' },
      files: [],
    });

    const accepted = await service.accept(astroUser, 'c-1');
    expect(accepted.status).toBe(ConsultationStatus.ACCEPTED);

    prisma.consultation.findUnique.mockResolvedValue({
      ...pending,
      expiresAt: new Date(Date.now() - 1000),
    });
    mockRespondTx(1);
    await expect(service.accept(astroUser, 'c-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  describe('list lifecycle enrichment', () => {
    const row = (id: string, status: ConsultationStatus) => ({
      id,
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      status,
      message: null,
      requestedPrice: new Prisma.Decimal('2500'),
      serviceNameSi: 'x',
      serviceNameEn: 'x',
      serviceId: 's-1',
      preferredStartAt: new Date('2030-01-10T04:30:00Z'),
      preferredEndAt: null,
      submittedAt: new Date(),
      viewedAt: null,
      respondedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      customer: { id: 'cust-1', name: 'C' },
      astrologer: { id: 'ap-1', displayName: 'A' },
    });

    const findManyWhere = () =>
      (
        prisma.consultation.findMany.mock.calls[0] as unknown as [
          { where: unknown },
        ]
      )[0].where;

    it('customer list scopes to own rows and enriches with bulk lifecycle data', async () => {
      prisma.consultation.findMany.mockResolvedValue([
        row('c-1', ConsultationStatus.PENDING),
        row('c-2', ConsultationStatus.ACCEPTED),
      ]);
      const result = (await service.listForCustomer(
        publicUser,
      )) as unknown as Array<{
        actionability: { stage: string; canCancelRequest: boolean };
        appointmentSummary: unknown;
      }>;
      expect(findManyWhere()).toMatchObject({
        customerId: 'cust-1',
      });
      expect(proposals.loadProposalSummaries).toHaveBeenCalledWith([
        'c-1',
        'c-2',
      ]);
      expect(payments.listLatestAppointmentViews).toHaveBeenCalledWith([
        'c-1',
        'c-2',
      ]);
      expect(result[0].actionability.stage).toBe('REQUEST_PENDING');
      expect(result[0].actionability.canCancelRequest).toBe(true);
      expect(result[1].actionability.stage).toBe('AWAITING_PROPOSAL');
      expect(result[1].appointmentSummary).toBeNull();
    });

    it('astrologer list scopes to own profile and grants respond only to pending requests', async () => {
      prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-1' });
      prisma.consultation.findMany.mockResolvedValue([
        row('c-1', ConsultationStatus.PENDING),
        row('c-2', ConsultationStatus.ACCEPTED),
      ]);
      const result = (await service.listForAstrologer(
        astroUser,
      )) as unknown as Array<{
        actionability: { canRespondToRequest: boolean; canPropose: boolean };
      }>;
      expect(findManyWhere()).toMatchObject({
        astrologerId: 'ap-1',
      });
      expect(result[0].actionability.canRespondToRequest).toBe(true);
      expect(result[1].actionability.canPropose).toBe(true);
      expect(result[1].actionability.canRespondToRequest).toBe(false);
    });

    it('rejects the wrong role', async () => {
      await expect(service.listForCustomer(astroUser)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('notification integration', () => {
    const pending = {
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      status: ConsultationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
    };

    function loadedRow() {
      prisma.astrologerProfile.findUnique.mockResolvedValue({
        id: 'ap-1',
        userId: 'astro-user-1',
      });
      prisma.consultation.findUnique.mockResolvedValue(pending);
      prisma.consultation.findUniqueOrThrow.mockResolvedValue({
        ...pending,
        status: ConsultationStatus.ACCEPTED,
        astrologerServiceId: 'as-1',
        serviceId: 'svc-1',
        requestedPrice: new Prisma.Decimal('1000'),
        serviceNameSi: 'a',
        serviceNameEn: 'b',
        message: null,
        preferredStartAt: new Date(),
        preferredEndAt: null,
        submittedAt: new Date(),
        viewedAt: null,
        respondedAt: new Date(),
        declineReason: null,
        customer: { id: 'cust-1', name: 'C' },
        files: [],
      });
    }

    const createDto = {
      astrologerId: 'ap-1',
      serviceId: 'svc-1',
      preferredStartAt: '2026-09-20T04:30:00.000Z',
    };

    it('create: records CONSULTATION_REQUESTED for the astrologer user in the same transaction and delivers after commit', async () => {
      mockHappyPathCreate();
      let committedAtDelivery: boolean | undefined;
      notifications.deliverAfterCommit.mockImplementation(() => {
        committedAtDelivery = txUsed.committed;
      });

      await service.create(publicUser, createDto);

      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        txUsed.current,
        'astro-user-1',
        { type: 'CONSULTATION_REQUESTED', consultationId: 'c-1' },
        'EN',
      );
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith(['n-1']);
      expect(committedAtDelivery).toBe(true);
    });

    it('create: the astrologer profile id is never used as the recipient', async () => {
      mockHappyPathCreate();
      await service.create(publicUser, createDto);
      const calls = notifications.notifyUser.mock.calls as unknown[][];
      const recipient = calls[0][1];
      expect(recipient).toBe('astro-user-1');
      expect(recipient).not.toBe('ap-1');
    });

    it('create: an unexpected notification failure rolls back and nothing is delivered', async () => {
      mockHappyPathCreate();
      notifications.notifyUser.mockRejectedValueOnce(new Error('deadlock'));
      await expect(service.create(publicUser, createDto)).rejects.toThrow(
        'deadlock',
      );
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('accept: a guarded update of one row records CONSULTATION_ACCEPTED for the customer in the same transaction', async () => {
      loadedRow();
      const tx = mockRespondTx(1);
      let committedAtDelivery: boolean | undefined;
      notifications.deliverAfterCommit.mockImplementation(() => {
        committedAtDelivery = txUsed.committed;
      });

      await service.accept(astroUser, 'c-1');

      expect(tx.consultation.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
      expect(notifications.notifyUser).toHaveBeenCalledWith(tx, 'cust-1', {
        type: 'CONSULTATION_ACCEPTED',
        consultationId: 'c-1',
      });
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith(['n-1']);
      expect(committedAtDelivery).toBe(true);
    });

    it('accept: a lost guard (0 rows) creates no notification and delivers nothing', async () => {
      loadedRow();
      mockRespondTx(0);
      await expect(service.accept(astroUser, 'c-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('decline: records CONSULTATION_DECLINED for the customer and never carries the reason', async () => {
      loadedRow();
      const tx = mockRespondTx(1);

      await service.decline(astroUser, 'c-1', { reason: 'private reason' });

      const updateArg = (
        tx.consultation.updateMany.mock.calls as unknown[][]
      )[0][0] as { data: { declineReason: string } };
      expect(updateArg.data.declineReason).toBe('private reason');
      expect(notifications.notifyUser).toHaveBeenCalledWith(tx, 'cust-1', {
        type: 'CONSULTATION_DECLINED',
        consultationId: 'c-1',
      });
      expect(JSON.stringify(notifications.notifyUser.mock.calls)).not.toContain(
        'private reason',
      );
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith(['n-1']);
    });

    it('decline: a lost guard (0 rows) creates no notification', async () => {
      loadedRow();
      mockRespondTx(0);
      await expect(
        service.decline(astroUser, 'c-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('accept: a duplicate or tolerated-invalid result (null id) is passed through so nothing is delivered', async () => {
      loadedRow();
      mockRespondTx(1);
      notifications.notifyUser.mockResolvedValueOnce(null);
      await service.accept(astroUser, 'c-1');
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith([null]);
    });

    it('accept: an unexpected notification failure propagates and nothing is delivered', async () => {
      loadedRow();
      mockRespondTx(1);
      notifications.notifyUser.mockRejectedValueOnce(new Error('fk failure'));
      await expect(service.accept(astroUser, 'c-1')).rejects.toThrow(
        'fk failure',
      );
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });
  });

  it('customer cannot cancel ACCEPTED', async () => {
    prisma.consultation.findUnique.mockResolvedValue({
      id: 'c-1',
      customerId: 'cust-1',
      status: ConsultationStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.cancel(publicUser, 'c-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  describe('appointment summary audience (payment privacy)', () => {
    const row = {
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      astrologerServiceId: 'as-1',
      serviceId: 'svc-1',
      requestedPrice: '1500.00',
      serviceNameSi: 'කේන්දර',
      serviceNameEn: 'Horoscope',
      message: null,
      status: ConsultationStatus.ACCEPTED,
      preferredStartAt: new Date('2026-10-01T04:30:00.000Z'),
      preferredEndAt: null,
      submittedAt: new Date('2026-09-30T04:30:00.000Z'),
      viewedAt: new Date('2026-09-30T05:00:00.000Z'),
      respondedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      declineReason: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      files: [],
      astrologer: { id: 'ap-1', displayName: 'Nimal' },
      customer: { id: 'cust-1', name: 'Kamal' },
    };

    beforeEach(() => {
      prisma.consultation.findUnique.mockResolvedValue(row);
      prisma.consultation.findUniqueOrThrow.mockResolvedValue(row);
      prisma.astrologerProfile.findUnique.mockResolvedValue({
        id: 'ap-1',
        userId: 'astro-user-1',
      });
    });

    it("the customer's detail uses the customer summary (with their payment)", async () => {
      await service.getForCustomer(publicUser, 'c-1');
      expect(payments.getSummaryForCustomer).toHaveBeenCalledWith('c-1');
      expect(payments.getSummaryForAstrologer).not.toHaveBeenCalled();
    });

    it("the astrologer's detail uses the payment-free summary", async () => {
      await service.getForAstrologer(astroUser, 'c-1', false);
      expect(payments.getSummaryForAstrologer).toHaveBeenCalledWith('c-1');
      expect(payments.getSummaryForCustomer).not.toHaveBeenCalled();
    });
  });

  describe('create idempotency', () => {
    const key = 'retry-key-01';
    const createDto = {
      astrologerId: 'ap-1',
      serviceId: 'svc-1',
      preferredStartAt: '2026-09-20T04:30:00.000Z',
      message: '  hello  ',
      files: [{ fileId: 'file-1', type: ConsultationFileType.IMAGE }],
    };
    const fingerprint = consultationRequestFingerprint({
      astrologerId: 'ap-1',
      serviceId: 'svc-1',
      preferredStartAt: new Date('2026-09-20T04:30:00.000Z'),
      preferredEndAt: null,
      message: 'hello',
      files: [{ fileId: 'file-1', type: ConsultationFileType.IMAGE }],
    });

    function pendingRow() {
      return {
        id: 'c-1',
        customerId: 'cust-1',
        status: ConsultationStatus.PENDING,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    }

    function mockLookup(
      matches: Array<{ id: string; requestFingerprint: string } | null>,
    ) {
      let index = 0;
      prisma.consultation.findUnique.mockImplementation(
        (args: {
          where: {
            id?: string;
            customerId_clientIdempotencyKey?: { customerId: string };
          };
        }) => {
          if (args.where.customerId_clientIdempotencyKey) {
            const row = matches[Math.min(index, matches.length - 1)] ?? null;
            index += 1;
            return Promise.resolve(row);
          }
          return Promise.resolve(pendingRow());
        },
      );
    }

    function mockCreateTx(options?: {
      existing?: { id: string; requestFingerprint: string } | null;
      createError?: unknown;
    }) {
      const tx = {
        consultation: {
          findUnique: jest.fn().mockResolvedValue(options?.existing ?? null),
          create: options?.createError
            ? jest.fn().mockRejectedValue(options.createError)
            : jest.fn().mockResolvedValue({
                id: 'c-1',
                customerId: 'cust-1',
                status: ConsultationStatus.PENDING,
              }),
        },
        file: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'file-1',
              mimeType: 'image/png',
              consultationFiles: [],
            },
          ]),
        },
        consultationFile: { createMany: jest.fn() },
      };
      prisma.$transaction.mockImplementation(
        async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      );
      return tx;
    }

    it('stores the key on the first submission and notifies once', async () => {
      mockHappyPathCreate();
      mockLookup([null]);
      const tx = mockCreateTx();

      const result = await service.create(publicUser, createDto, key);

      expect(result.status).toBe(ConsultationStatus.PENDING);
      expect(tx.consultation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            clientIdempotencyKey: key,
            requestFingerprint: fingerprint,
            message: 'hello',
          }),
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
      expect(notifications.deliverAfterCommit).toHaveBeenCalledWith(['n-1']);
    });

    it('returns the original consultation when the response was lost', async () => {
      mockHappyPathCreate();
      mockLookup([{ id: 'c-1', requestFingerprint: fingerprint }]);

      const result = await service.create(publicUser, createDto, key);

      expect(result.id).toBe('c-1');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(availability.assertPreferredSlotEligible).not.toHaveBeenCalled();
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('does not link files again when a concurrent insert already won', async () => {
      mockHappyPathCreate();
      mockLookup([null]);
      const tx = mockCreateTx({
        existing: { id: 'c-1', requestFingerprint: fingerprint },
      });

      await service.create(publicUser, createDto, key);

      expect(tx.consultation.create).not.toHaveBeenCalled();
      expect(tx.consultationFile.createMany).not.toHaveBeenCalled();
      expect(notifications.notifyUser).not.toHaveBeenCalled();
    });

    it('replays after a unique-constraint race with the same payload', async () => {
      mockHappyPathCreate();
      mockLookup([null, { id: 'c-1', requestFingerprint: fingerprint }]);
      const tx = mockCreateTx({
        createError: new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['customerId', 'clientIdempotencyKey'] },
          },
        ),
      });

      const result = await service.create(publicUser, createDto, key);

      expect(result.id).toBe('c-1');
      expect(tx.consultationFile.createMany).not.toHaveBeenCalled();
      expect(notifications.deliverAfterCommit).not.toHaveBeenCalled();
    });

    it('rejects the same key when the payload differs', async () => {
      mockHappyPathCreate();
      mockLookup([{ id: 'c-1', requestFingerprint: 'different' }]);

      await expect(
        service.create(
          publicUser,
          { ...createDto, message: 'something else' },
          key,
        ),
      ).rejects.toThrow(CONSULTATION_IDEMPOTENCY_CONFLICT);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('looks up the key for the authenticated customer only', async () => {
      mockHappyPathCreate();
      const seen: string[] = [];
      prisma.consultation.findUnique.mockImplementation(
        (args: {
          where: {
            id?: string;
            customerId_clientIdempotencyKey?: { customerId: string };
          };
        }) => {
          const scoped = args.where.customerId_clientIdempotencyKey;
          if (scoped) {
            seen.push(scoped.customerId);
            return Promise.resolve({
              id: `c-${scoped.customerId}`,
              requestFingerprint: fingerprint,
            });
          }
          const customerId = (args.where.id ?? 'c-cust-1').replace(/^c-/, '');
          return Promise.resolve({
            ...pendingRow(),
            id: args.where.id ?? 'c-cust-1',
            customerId,
          });
        },
      );
      prisma.consultation.findUniqueOrThrow.mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve({
            id: args.where.id,
            customerId: 'cust-1',
            astrologerId: 'ap-1',
            astrologerServiceId: 'as-1',
            serviceId: 'svc-1',
            status: ConsultationStatus.PENDING,
            requestedPrice: new Prisma.Decimal('1500.00'),
            serviceNameSi: 'කේන්දර',
            serviceNameEn: 'Horoscope',
            message: 'hello',
            preferredStartAt: new Date('2026-09-20T04:30:00.000Z'),
            preferredEndAt: null,
            submittedAt: new Date('2026-09-19T10:00:00.000Z'),
            viewedAt: null,
            respondedAt: null,
            expiresAt: new Date('2026-09-19T22:00:00.000Z'),
            declineReason: null,
            astrologer: { id: 'ap-1', displayName: 'Nimal' },
            files: [],
          }),
      );
      const otherCustomer = {
        id: 'cust-2',
        role: UserRole.PUBLIC,
        status: UserStatus.ACTIVE,
      } as never;

      const first = await service.create(publicUser, createDto, key);
      const second = await service.create(otherCustomer, createDto, key);

      expect(seen).toEqual(['cust-1', 'cust-2']);
      expect(first.id).toBe('c-cust-1');
      expect(second.id).toBe('c-cust-2');
    });
  });
});

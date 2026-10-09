import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  ConsultationStatus,
  ServiceStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
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
  };

  const payments = {
    getSummaryForConsultation: jest.fn().mockResolvedValue(null),
  };

  const notifications = {
    notifyUser: jest.fn().mockResolvedValue('n-1'),
    deliverAfterCommit: jest.fn(),
  };

  const service = new ConsultationsService(
    prisma as never,
    availability as never,
    proposals as never,
    payments as never,
    notifications as never,
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

  it('rejects inactive service and unoffered service', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'ap-1',
      status: AstrologerProfileStatus.ACTIVE,
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
});

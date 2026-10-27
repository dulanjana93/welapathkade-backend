import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  ConsultationStatus,
  Prisma,
  ServiceStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { ConsultationFollowUpService } from './consultation-follow-up.service';

describe('ConsultationFollowUpService', () => {
  const prisma = {
    consultation: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    consultationFollowUpMessage: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    astrologerProfile: { findUnique: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };

  const service = new ConsultationFollowUpService(prisma as never);

  const customer = {
    id: 'cust-1',
    role: UserRole.PUBLIC,
    status: UserStatus.ACTIVE,
  } as never;
  const astroUser = {
    id: 'astro-user-1',
    role: UserRole.ASTROLOGER,
    status: UserStatus.ACTIVE,
  } as never;

  const completedAt = new Date('2026-10-17T12:00:00.000Z');

  function completedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      serviceId: 'svc-1',
      status: ConsultationStatus.COMPLETED,
      completedAt,
      serviceNameSi: 'කේන්දර',
      serviceNameEn: 'Horoscope',
      astrologer: {
        userId: 'astro-user-1',
        displayName: 'Guru',
        status: AstrologerProfileStatus.ACTIVE,
        isOnline: true,
        user: { status: UserStatus.ACTIVE },
      },
      appointments: [{ status: 'COMPLETED' }],
      service: {
        status: ServiceStatus.ACTIVE,
        nameSi: 'කේන්දර',
        nameEn: 'Horoscope',
      },
      astrologerService: {
        status: AstrologerServiceStatus.ACTIVE,
        price: new Prisma.Decimal('800.00'),
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects message list before completion', async () => {
    prisma.consultation.findUnique.mockResolvedValue(
      completedRow({
        status: ConsultationStatus.ACCEPTED,
        completedAt: null,
        appointments: [{ status: 'CONFIRMED' }],
      }),
    );
    await expect(
      service.listForCustomer(customer, 'c-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects unrelated customer', async () => {
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    await expect(
      service.listForCustomer({ ...customer, id: 'other' } as never, 'c-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows 5 customer messages and rejects the 6th', async () => {
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    let sent = 0;
    prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) => {
      const tx = {
        $queryRaw: jest.fn(),
        consultationFollowUpMessage: {
          count: jest.fn().mockImplementation(() => Promise.resolve(sent)),
          create: jest
            .fn()
            .mockImplementation(({ data }: { data: { body: string } }) => {
              sent += 1;
              return Promise.resolve({
                id: `m-${sent}`,
                consultationId: 'c-1',
                senderUserId: 'cust-1',
                body: data.body,
                createdAt: new Date(),
              });
            }),
        },
        consultation: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(completedRow()),
        },
      };
      return Promise.resolve(fn(tx));
    });

    for (let i = 1; i <= 5; i += 1) {
      const msg = await service.sendForCustomer(customer, 'c-1', `hello ${i}`);
      expect(msg.body).toBe(`hello ${i}`);
    }
    await expect(
      service.sendForCustomer(customer, 'c-1', 'too many'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sent).toBe(5);
  });

  it('does not persist when body is empty after trim', async () => {
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    await expect(
      service.sendForCustomer(customer, 'c-1', '   '),
    ).rejects.toThrow(/required/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects send after the 48h window', async () => {
    jest.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    await expect(
      service.sendForCustomer(customer, 'c-1', 'late'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets the astrologer reply without the customer limit', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-1' });
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) => {
      const tx = {
        $queryRaw: jest.fn(),
        consultationFollowUpMessage: {
          count: jest.fn(),
          create: jest.fn().mockResolvedValue({
            id: 'm-a',
            consultationId: 'c-1',
            senderUserId: 'astro-user-1',
            body: 'reply',
            createdAt: new Date(),
          }),
        },
        consultation: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(completedRow()),
        },
      };
      return Promise.resolve(fn(tx));
    });

    const msg = await service.sendForAstrologer(astroUser, 'c-1', 'reply');
    expect(msg.senderRole).toBe('ASTROLOGER');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('only assigned astrologer may write a summary', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-other' });
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    await expect(
      service.upsertSummaryForAstrologer(astroUser, 'c-1', 'note'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects summary before completion', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-1' });
    prisma.consultation.findUnique.mockResolvedValue(
      completedRow({
        status: ConsultationStatus.ACCEPTED,
        completedAt: null,
        appointments: [{ status: 'IN_PROGRESS' }],
      }),
    );
    await expect(
      service.upsertSummaryForAstrologer(astroUser, 'c-1', 'note'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('upserts and clears summary for the assigned astrologer', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-1' });
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    prisma.consultation.update.mockResolvedValue({
      id: 'c-1',
      astrologerSummary: 'Reading done',
      astrologerSummaryUpdatedAt: new Date('2026-10-18T01:00:00.000Z'),
    });
    const saved = await service.upsertSummaryForAstrologer(
      astroUser,
      'c-1',
      '  Reading done  ',
    );
    expect(saved.astrologerSummary).toBe('Reading done');
    expect(prisma.consultation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-1' },
        data: expect.objectContaining({
          astrologerSummary: 'Reading done',
        }) as Record<string, unknown>,
      }),
    );

    prisma.consultation.update.mockResolvedValue({
      id: 'c-1',
      astrologerSummary: null,
      astrologerSummaryUpdatedAt: new Date(),
    });
    const cleared = await service.upsertSummaryForAstrologer(
      astroUser,
      'c-1',
      '   ',
    );
    expect(cleared.astrologerSummary).toBeNull();
  });

  it('book again is eligible only for completed + active offerings', async () => {
    prisma.consultation.findUnique.mockResolvedValue(completedRow());
    const ok = await service.bookAgainForCustomer(customer, 'c-1');
    expect(ok.eligible).toBe(true);
    expect(ok.requestedPrice).toBe('800.00');
    expect(ok.sourceConsultationId).toBe('c-1');

    prisma.consultation.findUnique.mockResolvedValue(
      completedRow({
        astrologerService: {
          status: AstrologerServiceStatus.INACTIVE,
          price: new Prisma.Decimal('800.00'),
        },
      }),
    );
    const bad = await service.bookAgainForCustomer(customer, 'c-1');
    expect(bad.eligible).toBe(false);
    expect(bad.reason).toMatch(/not active/i);
  });

  it('book again is ineligible when astrologer is Offline', async () => {
    prisma.consultation.findUnique.mockResolvedValue(
      completedRow({
        astrologer: {
          displayName: 'Guru',
          status: AstrologerProfileStatus.ACTIVE,
          isOnline: false,
          user: { status: UserStatus.ACTIVE },
        },
      }),
    );
    const result = await service.bookAgainForCustomer(customer, 'c-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/offline/i);
  });

  it('forbids non-public book again', async () => {
    await expect(
      service.bookAgainForCustomer(astroUser, 'c-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

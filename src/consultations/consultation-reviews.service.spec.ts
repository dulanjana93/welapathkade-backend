import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
  Prisma,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { ConsultationReviewsService } from './consultation-reviews.service';

describe('ConsultationReviewsService', () => {
  const prisma = {
    consultation: { findUnique: jest.fn() },
    consultationReview: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
    astrologerProfile: { findUnique: jest.fn() },
  };

  const service = new ConsultationReviewsService(prisma as never);

  const customer = {
    id: 'cust-1',
    role: UserRole.PUBLIC,
    status: UserStatus.ACTIVE,
  } as never;
  const astroUser = {
    id: 'astro-user',
    role: UserRole.ASTROLOGER,
    status: UserStatus.ACTIVE,
  } as never;

  function eligibleConsultation(overrides: Record<string, unknown> = {}) {
    return {
      id: 'c-1',
      customerId: 'cust-1',
      astrologerId: 'ap-1',
      status: ConsultationStatus.COMPLETED,
      appointments: [
        {
          status: AppointmentStatus.COMPLETED,
          refundObligation: null,
          payments: [{ status: PaymentStatus.PAID }],
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates 1-star and 5-star reviews for an eligible customer', async () => {
    prisma.consultation.findUnique.mockResolvedValue(eligibleConsultation());
    prisma.consultationReview.findUnique.mockResolvedValue(null);
    prisma.consultationReview.create.mockImplementation(
      async ({ data }: { data: { rating: number; body: string | null } }) => ({
        id: 'r-1',
        consultationId: 'c-1',
        rating: data.rating,
        body: data.body,
        createdAt: new Date('2026-10-18T00:00:00.000Z'),
        updatedAt: new Date('2026-10-18T00:00:00.000Z'),
      }),
    );

    const one = await service.createForCustomer(customer, 'c-1', 1, undefined);
    expect(one.rating).toBe(1);
    expect(one.body).toBeNull();

    const five = await service.createForCustomer(customer, 'c-1', 5, '  Great  ');
    expect(five.rating).toBe(5);
    expect(five.body).toBe('Great');
  });

  it('rejects non-owners, astrologers and ineligible states', async () => {
    await expect(
      service.createForCustomer(astroUser, 'c-1', 5, 'no'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.consultation.findUnique.mockResolvedValue(
      eligibleConsultation({ customerId: 'other' }),
    );
    await expect(
      service.createForCustomer(customer, 'c-1', 5, 'no'),
    ).rejects.toBeInstanceOf(NotFoundException);

    prisma.consultation.findUnique.mockResolvedValue(
      eligibleConsultation({
        appointments: [
          {
            status: AppointmentStatus.CANCELLED_BY_ASTROLOGER,
            refundObligation: 'FULL_REFUND_DUE',
            payments: [{ status: PaymentStatus.PAID }],
          },
        ],
      }),
    );
    await expect(
      service.createForCustomer(customer, 'c-1', 5, 'no'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects duplicate create and maps unique constraint races', async () => {
    prisma.consultation.findUnique.mockResolvedValue(eligibleConsultation());
    prisma.consultationReview.findUnique.mockResolvedValue({
      id: 'r-1',
      customerId: 'cust-1',
    });
    await expect(
      service.createForCustomer(customer, 'c-1', 4, 'dup'),
    ).rejects.toBeInstanceOf(ConflictException);

    prisma.consultationReview.findUnique.mockResolvedValue(null);
    prisma.consultationReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.createForCustomer(customer, 'c-1', 4, 'race'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows the owner to edit and blocks others', async () => {
    prisma.consultation.findUnique.mockResolvedValue(eligibleConsultation());
    prisma.consultationReview.findUnique.mockResolvedValue({
      id: 'r-1',
      customerId: 'cust-1',
      consultationId: 'c-1',
      rating: 3,
      body: 'ok',
    });
    prisma.consultationReview.update.mockResolvedValue({
      id: 'r-1',
      consultationId: 'c-1',
      rating: 5,
      body: 'better',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const updated = await service.updateForCustomer(
      customer,
      'c-1',
      5,
      'better',
    );
    expect(updated.rating).toBe(5);

    prisma.consultationReview.findUnique.mockResolvedValue({
      id: 'r-1',
      customerId: 'other',
    });
    await expect(
      service.updateForCustomer(customer, 'c-1', 2, 'steal'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('aggregates only eligible reviews and returns null average for zero', async () => {
    prisma.consultationReview.groupBy.mockResolvedValue([
      {
        astrologerId: 'ap-1',
        _avg: { rating: 4.5 },
        _count: { _all: 2 },
      },
    ]);
    const map = await service.aggregateForAstrologers(['ap-1', 'ap-2']);
    expect(map.get('ap-1')).toEqual({ averageRating: 4.5, reviewCount: 2 });
    expect(map.get('ap-2')).toEqual({ averageRating: null, reviewCount: 0 });
  });

  it('lists public reviews with privacy-safe author labels', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-1' });
    prisma.consultationReview.count.mockResolvedValue(1);
    prisma.consultationReview.findMany.mockResolvedValue([
      {
        id: 'r-1',
        rating: 5,
        body: 'Nice',
        createdAt: new Date('2026-10-18T00:00:00.000Z'),
        customer: { name: 'Kamal Silva' },
      },
    ]);
    prisma.consultationReview.groupBy.mockResolvedValue([
      {
        astrologerId: 'ap-1',
        _avg: { rating: 5 },
        _count: { _all: 1 },
      },
    ]);

    const page = await service.listPublicForAstrologer('ap-1', 1, 20);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        authorLabel: 'Kamal',
        rating: 5,
        body: 'Nice',
      }),
    );
    expect(page.items[0]).not.toHaveProperty('customerId');
    expect(page.items[0]).not.toHaveProperty('consultationId');
  });
});

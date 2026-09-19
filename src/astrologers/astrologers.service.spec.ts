import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  Prisma,
  ServiceStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AstrologersService } from './astrologers.service';

describe('AstrologersService', () => {
  const prisma = {
    astrologerProfile: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    astrologerService: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    service: {
      findUnique: jest.fn(),
    },
  };

  const astrologerUser = {
    id: 'u1',
    role: UserRole.ASTROLOGER,
    status: UserStatus.ACTIVE,
  } as never;

  const publicUser = {
    id: 'u2',
    role: UserRole.PUBLIC,
    status: UserStatus.ACTIVE,
  } as never;

  const availabilityService = {
    hasConfiguredAvailability: jest.fn().mockResolvedValue(true),
    getScheduleForAstrologer: jest.fn().mockResolvedValue({
      timezone: 'Asia/Colombo',
      weekly: {},
      exceptions: [],
    }),
  };

  let service: AstrologersService;

  beforeEach(() => {
    jest.resetAllMocks();
    availabilityService.hasConfiguredAvailability.mockResolvedValue(true);
    service = new AstrologersService(
      prisma as never,
      { write: jest.fn() } as never,
      availabilityService as never,
    );
  });

  it('forbids non-astrologers from managing profile', async () => {
    await expect(service.getOwnProfile(publicUser)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects price below min', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
    });
    prisma.service.findUnique.mockResolvedValue({
      id: 's1',
      status: ServiceStatus.ACTIVE,
      minPrice: new Prisma.Decimal('1000.00'),
      maxPrice: new Prisma.Decimal('5000.00'),
    });
    prisma.astrologerService.findUnique.mockResolvedValue(null);

    await expect(
      service.assignService(astrologerUser, { serviceId: 's1', price: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate active assignment', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
    });
    prisma.service.findUnique.mockResolvedValue({
      id: 's1',
      status: ServiceStatus.ACTIVE,
      minPrice: new Prisma.Decimal('500.00'),
      maxPrice: new Prisma.Decimal('5000.00'),
    });
    prisma.astrologerService.findUnique.mockResolvedValue({
      id: 'as1',
      status: AstrologerServiceStatus.ACTIVE,
    });

    await expect(
      service.assignService(astrologerUser, { serviceId: 's1', price: 1500 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('hides non-discoverable profiles from public get', async () => {
    prisma.astrologerProfile.findFirst.mockResolvedValue(null);
    await expect(service.getDiscoverableById('p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists discoverable profiles without private fields', async () => {
    prisma.astrologerProfile.findMany.mockResolvedValue([
      {
        id: 'p1',
        displayName: 'A',
        bio: 'bio',
        experienceYears: 3,
        photo: null,
        city: 'Colombo',
        district: 'Colombo',
        status: AstrologerProfileStatus.ACTIVE,
        services: [
          {
            serviceId: 's1',
            status: AstrologerServiceStatus.ACTIVE,
            price: new Prisma.Decimal('1500'),
            service: {
              code: 'HOROSCOPE_READING',
              nameSi: 'කේන්දර බැලීම',
              nameEn: 'Horoscope reading',
              descriptionSi: null,
              descriptionEn: null,
            },
          },
        ],
      },
    ]);

    const rows = await service.listDiscoverable({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('phone');
    expect(rows[0]).not.toHaveProperty('referralCode');
    expect(rows[0]).not.toHaveProperty('referredByUserId');
    expect(rows[0].services[0].price).toBe('1500.00');
  });
});

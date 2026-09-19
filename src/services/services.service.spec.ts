import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ServiceStatus } from '@prisma/client';
import { ServicesService } from './services.service';

describe('ServicesService', () => {
  const prisma = {
    service: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  let service: ServicesService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new ServicesService(prisma as never);
  });

  it('lists only active services publicly', async () => {
    prisma.service.findMany.mockResolvedValue([
      {
        id: '1',
        code: 'A',
        nameSi: 'අ',
        nameEn: 'A',
        descriptionSi: null,
        descriptionEn: null,
        minPrice: new Prisma.Decimal('100.00'),
        maxPrice: new Prisma.Decimal('200.00'),
        status: ServiceStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const rows = await service.listActivePublic();
    expect(prisma.service.findMany).toHaveBeenCalledWith({
      where: { status: ServiceStatus.ACTIVE },
      orderBy: { nameEn: 'asc' },
    });
    expect(rows[0].minPrice).toBe('100.00');
  });

  it('lists all services for admin including inactive', async () => {
    prisma.service.findMany.mockResolvedValue([
      {
        id: '1',
        code: 'A',
        nameSi: 'අ',
        nameEn: 'A',
        descriptionSi: null,
        descriptionEn: null,
        minPrice: new Prisma.Decimal('100.00'),
        maxPrice: new Prisma.Decimal('200.00'),
        status: ServiceStatus.INACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const rows = await service.listAllAdmin();
    expect(prisma.service.findMany).toHaveBeenCalledWith({
      orderBy: { nameEn: 'asc' },
    });
    expect(rows[0].status).toBe(ServiceStatus.INACTIVE);
    expect(rows[0]).toHaveProperty('createdAt');
  });

  it('rejects invalid min/max on create', async () => {
    await expect(
      service.create({
        code: 'X',
        nameSi: 'x',
        nameEn: 'x',
        minPrice: 100,
        maxPrice: 50,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps duplicate code to conflict', async () => {
    prisma.service.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create({
        code: 'X',
        nameSi: 'x',
        nameEn: 'x',
        minPrice: 10,
        maxPrice: 20,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws not found for missing active service', async () => {
    prisma.service.findFirst.mockResolvedValue(null);
    await expect(service.getActivePublicById('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

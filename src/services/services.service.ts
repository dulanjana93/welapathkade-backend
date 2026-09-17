import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Service, ServiceStatus } from '@prisma/client';
import { toDecimal } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';
import {
  toAdminServiceView,
  toPublicServiceView,
} from './service.mapper';

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  listActivePublic() {
    return this.prisma.service
      .findMany({
        where: { status: ServiceStatus.ACTIVE },
        orderBy: { nameEn: 'asc' },
      })
      .then((rows) => rows.map(toPublicServiceView));
  }

  async getActivePublicById(id: string) {
    const service = await this.prisma.service.findFirst({
      where: { id, status: ServiceStatus.ACTIVE },
    });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    return toPublicServiceView(service);
  }

  async getByIdOrThrow(id: string): Promise<Service> {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    return service;
  }

  async create(dto: CreateServiceDto) {
    this.assertPriceBounds(dto.minPrice, dto.maxPrice);
    try {
      const created = await this.prisma.service.create({
        data: {
          code: dto.code.trim().toUpperCase(),
          nameSi: dto.nameSi.trim(),
          nameEn: dto.nameEn.trim(),
          descriptionSi: dto.descriptionSi?.trim() || null,
          descriptionEn: dto.descriptionEn?.trim() || null,
          minPrice: toDecimal(dto.minPrice),
          maxPrice: toDecimal(dto.maxPrice),
          status: dto.status ?? ServiceStatus.ACTIVE,
        },
      });
      return toAdminServiceView(created);
    } catch (error) {
      this.rethrowUniqueCode(error);
      throw error;
    }
  }

  async update(id: string, dto: UpdateServiceDto) {
    const existing = await this.getByIdOrThrow(id);

    const minPrice =
      dto.minPrice !== undefined ? dto.minPrice : Number(existing.minPrice);
    const maxPrice =
      dto.maxPrice !== undefined ? dto.maxPrice : Number(existing.maxPrice);
    this.assertPriceBounds(minPrice, maxPrice);

    try {
      const updated = await this.prisma.service.update({
        where: { id },
        data: {
          ...(dto.code !== undefined
            ? { code: dto.code.trim().toUpperCase() }
            : {}),
          ...(dto.nameSi !== undefined ? { nameSi: dto.nameSi.trim() } : {}),
          ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn.trim() } : {}),
          ...(dto.descriptionSi !== undefined
            ? { descriptionSi: dto.descriptionSi?.trim() || null }
            : {}),
          ...(dto.descriptionEn !== undefined
            ? { descriptionEn: dto.descriptionEn?.trim() || null }
            : {}),
          ...(dto.minPrice !== undefined
            ? { minPrice: toDecimal(dto.minPrice) }
            : {}),
          ...(dto.maxPrice !== undefined
            ? { maxPrice: toDecimal(dto.maxPrice) }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return toAdminServiceView(updated);
    } catch (error) {
      this.rethrowUniqueCode(error);
      throw error;
    }
  }

  private assertPriceBounds(minPrice: number, maxPrice: number): void {
    if (minPrice < 0 || maxPrice < 0) {
      throw new BadRequestException('Prices must be >= 0');
    }
    if (maxPrice < minPrice) {
      throw new BadRequestException(
        'maxPrice must be greater than or equal to minPrice',
      );
    }
  }

  private rethrowUniqueCode(error: unknown): void {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('Service code already exists');
    }
  }
}

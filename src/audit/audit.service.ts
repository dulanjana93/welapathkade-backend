import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(params: {
    adminUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    oldData?: Prisma.InputJsonValue | null;
    newData?: Prisma.InputJsonValue | null;
    ip?: string | null;
  }) {
    return this.prisma.auditLog.create({
      data: {
        adminUserId: params.adminUserId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        oldData: params.oldData ?? Prisma.JsonNull,
        newData: params.newData ?? Prisma.JsonNull,
        ip: params.ip ?? null,
      },
    });
  }
}

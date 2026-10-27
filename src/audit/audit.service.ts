import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type AuditClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist an admin audit row. Pass a transaction client when the audit must
   * commit atomically with a business write.
   */
  async record(
    params: {
      adminUserId: string;
      action: string;
      entityType: string;
      entityId: string;
      oldData?: Prisma.InputJsonValue | null;
      newData?: Prisma.InputJsonValue | null;
      ip?: string | null;
    },
    client: AuditClient = this.prisma,
  ) {
    return client.auditLog.create({
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

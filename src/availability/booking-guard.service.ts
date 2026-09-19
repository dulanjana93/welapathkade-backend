import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Row-lock foundation for future appointment/reservation writes.
 *
 * Intended usage (later phases):
 *   await bookingGuard.withAstrologerLock(astrologerId, async (tx) => {
 *     // check conflicts, create appointment…
 *   });
 */
@Injectable()
export class BookingGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureGuard(astrologerId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    await client.astrologerBookingGuard.upsert({
      where: { astrologerId },
      create: { astrologerId },
      update: {},
    });
  }

  /**
   * Acquire SELECT … FOR UPDATE on the astrologer's guard row inside a transaction.
   */
  async withAstrologerLock<T>(
    astrologerId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.ensureGuard(astrologerId, tx);
      await tx.$queryRaw`
        SELECT \`astrologerId\`
        FROM \`AstrologerBookingGuard\`
        WHERE \`astrologerId\` = ${astrologerId}
        FOR UPDATE
      `;
      return work(tx);
    });
  }
}

import { ConsultationStatus, type Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The single rule for expiring unanswered consultation requests:
 * `PENDING` and `expiresAt <= now` become `EXPIRED`.
 *
 * It is one guarded `updateMany`, so it is idempotent, safe to run
 * concurrently (from reads, accept/decline paths, or the background sweeper on
 * any number of instances) and mutually exclusive with accept/decline, which
 * update with the complementary condition `expiresAt > now`.
 *
 * `scope` narrows the rows (a single id, one customer, one astrologer); an
 * empty scope sweeps every due request. Returns how many rows changed.
 */
export async function expirePendingConsultations(
  db: PrismaService | Prisma.TransactionClient,
  now: Date,
  scope: Prisma.ConsultationWhereInput = {},
): Promise<number> {
  const result = await db.consultation.updateMany({
    where: {
      ...scope,
      status: ConsultationStatus.PENDING,
      expiresAt: { lte: now },
    },
    data: { status: ConsultationStatus.EXPIRED },
  });
  return result.count;
}

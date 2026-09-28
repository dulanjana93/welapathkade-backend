import type { PrismaService } from '../src/prisma/prisma.service';
import type { RedisService } from '../src/redis/redis.service';
import { assertTestDatabase } from '../src/common/database-safety/assert-test-database';

/**
 * Shared E2E cleanup. ALWAYS gated by assertTestDatabase().
 * Must never run against the development database (welapathkade).
 */
export async function resetE2eDatabase(prisma: PrismaService): Promise<void> {
  assertTestDatabase();

  await prisma.paymentAttempt.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.consultationProposal.deleteMany();
  await prisma.consultationFile.deleteMany();
  await prisma.consultation.deleteMany();
  await prisma.file.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.availabilityException.deleteMany();
  await prisma.weeklyAvailability.deleteMany();
  await prisma.astrologerBookingGuard.deleteMany();
  await prisma.astrologerApplication.deleteMany();
  await prisma.astrologerService.deleteMany();
  await prisma.astrologerProfile.deleteMany();
  await prisma.service.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.userDevice.deleteMany();
  await prisma.otpVerification.deleteMany();
  await prisma.user.deleteMany();
}

export async function resetE2eRedisOtps(redis: RedisService): Promise<void> {
  assertTestDatabase();

  const client = redis.getClient();
  const keys = await client.keys('otp:*');
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

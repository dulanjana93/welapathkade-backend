import type { PrismaService } from '../src/prisma/prisma.service';
import type { RedisService } from '../src/redis/redis.service';
import { assertTestDatabase } from '../src/common/database-safety/assert-test-database';

/**
 * Shared E2E cleanup. ALWAYS gated by assertTestDatabase().
 * Must never run against the development database (welapathkade).
 */
export async function resetE2eDatabase(prisma: PrismaService): Promise<void> {
  assertTestDatabase();

  // Notification.userId is ON DELETE RESTRICT: must go before users.
  await prisma.notification.deleteMany();
  // Phase B ledger/wallet rows reference snapshots, payments, appointments, users.
  // DEBITs must go first: reversesEntryId → CREDIT is ON DELETE RESTRICT.
  try {
    await prisma.ledgerEntry.deleteMany({ where: { kind: 'DEBIT' } });
    await prisma.ledgerEntry.deleteMany();
  } catch {
    // ignore until Phase B migration is applied
  }
  try {
    await prisma.appointmentFinancialSnapshot.deleteMany();
  } catch {
    // ignore until Phase A migration is applied
  }
  try {
    await prisma.walletAccount.deleteMany();
  } catch {
    // ignore until Phase B migration is applied
  }
  try {
    await prisma.platformAccount.updateMany({
      data: { availableBalance: 0 },
    });
  } catch {
    // ignore until Phase B migration is applied
  }
  await prisma.paymentAttempt.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.astrologerReliabilityIncident.deleteMany();
  // B3-a table may be absent until its migration is applied to the test DB.
  try {
    await prisma.sessionAttendanceEvidence.deleteMany();
  } catch {
    // ignore missing-table errors so pre-migration e2e suites still clean up
  }
  await prisma.appointment.deleteMany();
  await prisma.consultationProposal.deleteMany();
  await prisma.consultationFile.deleteMany();
  try {
    await prisma.consultationFollowUpMessage.deleteMany();
  } catch {
    // ignore missing-table errors until the Phase 2 migration is applied
  }
  try {
    await prisma.consultationReview.deleteMany();
  } catch {
    // ignore missing-table errors until the Phase 3 migration is applied
  }
  await prisma.consultation.deleteMany();
  await prisma.file.deleteMany();
  try {
    await prisma.referralAttributionCorrection.deleteMany();
  } catch {
    // ignore until Phase C migration is applied
  }
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
  try {
    await prisma.withdrawalEvent.deleteMany();
    await prisma.withdrawalDebit.deleteMany();
    await prisma.withdrawalRequest.deleteMany();
    await prisma.astrologerBankAccount.deleteMany();
  } catch {
    // ignore until the withdrawal migration is applied
  }
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

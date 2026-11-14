/**
 * One-off resolution of saved-card registrations left PENDING by the old
 * lifecycle (before `POST /me/payment-methods/:id/complete` existed).
 *
 * Scope: only `SavedPaymentMethod` rows with status PENDING created before
 * --created-before. ACTIVE, DISABLED, REMOVED, and FAILED rows are never
 * touched. Nothing is deleted. Consent events are kept as they are.
 *
 * Dry run (default) prints what would change and writes nothing:
 *   npm run saved-cards:resolve-legacy-pending -- --created-before 2026-11-15T00:00:00Z
 *
 * Apply (after review, against the intended database only):
 *   npm run saved-cards:resolve-legacy-pending -- --created-before 2026-11-15T00:00:00Z --apply
 *
 * With --apply it first writes an archive JSON (the affected rows without
 * token columns, plus all their consent events) to --archive-dir
 * (default ./storage/archive), then marks exactly those rows FAILED with
 * failureReason LEGACY_PENDING and releases openCardSlot. A row that changed
 * since the archive was taken (for example a PayHere notify activated it) is
 * skipped by the status guard. A PayHere success that arrives later for a
 * resolved row is flagged as lateAuthorizationAt by the notify handler.
 *
 * Uses DATABASE_URL from the environment, like the API.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  PrismaClient,
  SavedCardFailureReason,
  SavedCardStatus,
} from '@prisma/client';
import { failStalePendingRegistrations } from '../payments/saved-card.service';

function readArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const rawCutoff = readArg('created-before');
  const apply = process.argv.includes('--apply');
  const archiveDir = resolve(readArg('archive-dir') ?? './storage/archive');
  if (!rawCutoff) {
    throw new Error('Missing required --created-before <ISO timestamp>');
  }
  const createdBefore = new Date(rawCutoff);
  if (Number.isNaN(createdBefore.getTime())) {
    throw new Error('--created-before must be an ISO timestamp');
  }
  if (createdBefore.getTime() > Date.now()) {
    throw new Error('--created-before must not be in the future');
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.savedPaymentMethod.findMany({
      where: {
        status: SavedCardStatus.PENDING,
        createdAt: { lt: createdBefore },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        provider: true,
        status: true,
        merchantReference: true,
        payherePaymentId: true,
        consentVersion: true,
        consentedAt: true,
        authorizationEnabled: true,
        openCardSlot: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    console.log(
      `${rows.length} legacy PENDING registration(s) created before ${createdBefore.toISOString()}`,
    );
    for (const row of rows) {
      console.log(
        `  ${row.id} user=${row.userId} ref=${row.merchantReference} created=${row.createdAt.toISOString()}`,
      );
    }
    if (!apply) {
      console.log('Dry run. Nothing written. Re-run with --apply to resolve.');
      return;
    }
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    const consentEvents = await prisma.savedCardConsentEvent.findMany({
      where: { savedPaymentMethodId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    const now = new Date();
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(
      archiveDir,
      `saved-card-legacy-pending-${now.toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(
      archivePath,
      JSON.stringify(
        {
          archivedAt: now.toISOString(),
          createdBefore: createdBefore.toISOString(),
          resolution: {
            status: SavedCardStatus.FAILED,
            failureReason: SavedCardFailureReason.LEGACY_PENDING,
          },
          savedPaymentMethods: rows,
          savedCardConsentEvents: consentEvents,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(
      `Archived ${rows.length} row(s) and ${consentEvents.length} consent event(s) to ${archivePath}`,
    );

    const { failed } = await failStalePendingRegistrations(prisma, {
      createdBefore,
      reason: SavedCardFailureReason.LEGACY_PENDING,
      now,
      ids,
    });
    console.log(
      `Resolved ${failed} of ${rows.length} as FAILED (LEGACY_PENDING). Skipped ${rows.length - failed} that changed since the archive.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

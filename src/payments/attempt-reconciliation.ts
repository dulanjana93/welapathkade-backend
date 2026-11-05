import { PaymentStatus } from '@prisma/client';

/**
 * Shared customer-facing reconciliation flag.
 *
 * True when the attempt is under review or still owns the one open charge
 * slot. A verified paid attempt is never reported as needing reconciliation.
 * An unsent failure releases the slot and is not under review, so it is false.
 * The slot id itself is not part of the response.
 */
export function attemptRequiresReconciliation(
  attempt:
    | {
        status?: PaymentStatus | null;
        requiresReview?: boolean | null;
        openChargeSlot?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!attempt || attempt.status === PaymentStatus.PAID) return false;
  return attempt.requiresReview === true || Boolean(attempt.openChargeSlot);
}

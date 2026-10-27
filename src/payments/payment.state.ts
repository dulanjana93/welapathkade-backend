import { PaymentStatus } from '@prisma/client';

/**
 * Payment state machine (Phase 5B V1).
 *
 * PENDING
 *  ├── SUCCESS_VERIFIED → PAID
 *  ├── GATEWAY_FAILURE  → FAILED
 *  └── HOLD_TIMEOUT     → EXPIRED
 *
 * PAID is terminal success. Duplicate callbacks stay PAID.
 */
export type PaymentTransition =
  'SUCCESS_VERIFIED' | 'GATEWAY_FAILURE' | 'HOLD_TIMEOUT';

const ALLOWED: Record<
  PaymentTransition,
  { from: PaymentStatus; to: PaymentStatus }
> = {
  SUCCESS_VERIFIED: { from: PaymentStatus.PENDING, to: PaymentStatus.PAID },
  GATEWAY_FAILURE: { from: PaymentStatus.PENDING, to: PaymentStatus.FAILED },
  HOLD_TIMEOUT: { from: PaymentStatus.PENDING, to: PaymentStatus.EXPIRED },
};

export function assertPaymentTransition(
  current: PaymentStatus,
  transition: PaymentTransition,
): PaymentStatus {
  const rule = ALLOWED[transition];
  if (current !== rule.from) {
    throw new Error(`Invalid payment transition ${transition} from ${current}`);
  }
  return rule.to;
}

export function isPaymentPaid(status: PaymentStatus): boolean {
  return status === PaymentStatus.PAID;
}

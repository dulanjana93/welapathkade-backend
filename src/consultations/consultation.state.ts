import { ConsultationStatus } from '@prisma/client';

/**
 * Consultation request state machine (Phase 4).
 *
 * PENDING
 *  ├── ACCEPT          → ACCEPTED
 *  ├── DECLINE         → DECLINED
 *  ├── 12h timeout     → EXPIRED
 *  └── CUSTOMER_CANCEL → CANCELLED
 *
 * ACCEPTED is not terminal (appointment proposal follows in Phase 5).
 * DECLINED / EXPIRED / CANCELLED are terminal for the request lifecycle.
 */
export const CONSULTATION_TERMINAL_STATUSES: ReadonlySet<ConsultationStatus> =
  new Set([
    ConsultationStatus.DECLINED,
    ConsultationStatus.EXPIRED,
    ConsultationStatus.CANCELLED,
  ]);

export type ConsultationTransition =
  | 'ACCEPT'
  | 'DECLINE'
  | 'TIMEOUT'
  | 'CUSTOMER_CANCEL';

const ALLOWED: Record<
  ConsultationTransition,
  { from: ConsultationStatus; to: ConsultationStatus }
> = {
  ACCEPT: {
    from: ConsultationStatus.PENDING,
    to: ConsultationStatus.ACCEPTED,
  },
  DECLINE: {
    from: ConsultationStatus.PENDING,
    to: ConsultationStatus.DECLINED,
  },
  TIMEOUT: {
    from: ConsultationStatus.PENDING,
    to: ConsultationStatus.EXPIRED,
  },
  CUSTOMER_CANCEL: {
    from: ConsultationStatus.PENDING,
    to: ConsultationStatus.CANCELLED,
  },
};

export function assertConsultationTransition(
  current: ConsultationStatus,
  transition: ConsultationTransition,
): ConsultationStatus {
  const rule = ALLOWED[transition];
  if (current !== rule.from) {
    throw new Error(
      `Invalid consultation transition ${transition} from ${current}`,
    );
  }
  return rule.to;
}

export function isConsultationTerminal(status: ConsultationStatus): boolean {
  return CONSULTATION_TERMINAL_STATUSES.has(status);
}

/** Phase 4 request actions (accept/decline/cancel) are blocked after leaving PENDING. */
export function isConsultationRequestActionLocked(
  status: ConsultationStatus,
): boolean {
  return status !== ConsultationStatus.PENDING;
}

/** ACCEPTED blocks further request actions in Phase 4 (accept/decline/cancel). */
export function canAstrologerRespond(status: ConsultationStatus): boolean {
  return status === ConsultationStatus.PENDING;
}

export function canCustomerCancel(status: ConsultationStatus): boolean {
  return status === ConsultationStatus.PENDING;
}

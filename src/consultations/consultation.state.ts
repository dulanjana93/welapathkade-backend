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
 * ACCEPTED
 *  ├── APPOINTMENT_CLOSED    → CANCELLED  (linked appointment cancelled / no-show)
 *  └── APPOINTMENT_COMPLETED → COMPLETED  (linked appointment completed)
 *
 * The two ACCEPTED transitions are driven only by AppointmentLifecycleService,
 * in the same transaction as the appointment transition. The appointment keeps
 * the exact outcome (who cancelled, which participant was absent).
 * DECLINED / EXPIRED / CANCELLED / COMPLETED are terminal.
 */
export const CONSULTATION_TERMINAL_STATUSES: ReadonlySet<ConsultationStatus> =
  new Set([
    ConsultationStatus.DECLINED,
    ConsultationStatus.EXPIRED,
    ConsultationStatus.CANCELLED,
    ConsultationStatus.COMPLETED,
  ]);

export type ConsultationTransition =
  | 'ACCEPT'
  | 'DECLINE'
  | 'TIMEOUT'
  | 'CUSTOMER_CANCEL'
  | 'APPOINTMENT_CLOSED'
  | 'APPOINTMENT_COMPLETED';

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
  APPOINTMENT_CLOSED: {
    from: ConsultationStatus.ACCEPTED,
    to: ConsultationStatus.CANCELLED,
  },
  APPOINTMENT_COMPLETED: {
    from: ConsultationStatus.ACCEPTED,
    to: ConsultationStatus.COMPLETED,
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

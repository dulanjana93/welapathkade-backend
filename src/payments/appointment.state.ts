import { AppointmentStatus } from '@prisma/client';

/**
 * Appointment state machine.
 *
 * Appointment lifecycle only; it is independent of PaymentStatus (the gateway
 * transaction). Real refunds are NOT modelled here: cancellation / no-show
 * outcomes record a refund *obligation* on the appointment, nothing more.
 *
 * PAYMENT_PENDING
 *  ├── PAYMENT_SUCCESS    → CONFIRMED
 *  └── PAYMENT_TIMEOUT    → PAYMENT_EXPIRED
 * CONFIRMED
 *  ├── SESSION_START      → IN_PROGRESS             (verified session event)
 *  ├── CUSTOMER_CANCEL    → CANCELLED_BY_CUSTOMER   (customer)
 *  ├── ASTROLOGER_CANCEL  → CANCELLED_BY_ASTROLOGER (astrologer)
 *  ├── CUSTOMER_NO_SHOW   → NO_SHOW_CUSTOMER        (verified attendance report)
 *  ├── ASTROLOGER_NO_SHOW → NO_SHOW_ASTROLOGER      (verified attendance report)
 *  └── BOTH_NO_SHOW       → NO_SHOW_BOTH            (verified attendance report)
 * IN_PROGRESS
 *  └── SESSION_END        → COMPLETED               (verified session event)
 *
 * Terminal for this phase: PAYMENT_EXPIRED, COMPLETED, CANCELLED_BY_*,
 * NO_SHOW_*. `CANCELLED` is a legacy Phase 5B value that is never written.
 * NO_SHOW_CUSTOMER can only be left via a future admin review (not built).
 */
export type AppointmentTransition =
  | 'PAYMENT_SUCCESS'
  | 'PAYMENT_TIMEOUT'
  | 'SESSION_START'
  | 'SESSION_END'
  | 'CUSTOMER_CANCEL'
  | 'ASTROLOGER_CANCEL'
  | 'CUSTOMER_NO_SHOW'
  | 'ASTROLOGER_NO_SHOW'
  | 'BOTH_NO_SHOW';

/** Who or what is allowed to initiate a transition. */
export type AppointmentTransitionInitiator =
  | 'VERIFIED_PAYMENT'
  | 'RESERVATION_EXPIRY'
  | 'VERIFIED_SESSION_EVENT'
  | 'VERIFIED_ATTENDANCE_REPORT'
  | 'CUSTOMER'
  | 'ASTROLOGER';

const ALLOWED: Record<
  AppointmentTransition,
  {
    from: AppointmentStatus;
    to: AppointmentStatus;
    initiator: AppointmentTransitionInitiator;
  }
> = {
  PAYMENT_SUCCESS: {
    from: AppointmentStatus.PAYMENT_PENDING,
    to: AppointmentStatus.CONFIRMED,
    initiator: 'VERIFIED_PAYMENT',
  },
  PAYMENT_TIMEOUT: {
    from: AppointmentStatus.PAYMENT_PENDING,
    to: AppointmentStatus.PAYMENT_EXPIRED,
    initiator: 'RESERVATION_EXPIRY',
  },
  SESSION_START: {
    from: AppointmentStatus.CONFIRMED,
    to: AppointmentStatus.IN_PROGRESS,
    initiator: 'VERIFIED_SESSION_EVENT',
  },
  SESSION_END: {
    from: AppointmentStatus.IN_PROGRESS,
    to: AppointmentStatus.COMPLETED,
    initiator: 'VERIFIED_SESSION_EVENT',
  },
  CUSTOMER_CANCEL: {
    from: AppointmentStatus.CONFIRMED,
    to: AppointmentStatus.CANCELLED_BY_CUSTOMER,
    initiator: 'CUSTOMER',
  },
  ASTROLOGER_CANCEL: {
    from: AppointmentStatus.CONFIRMED,
    to: AppointmentStatus.CANCELLED_BY_ASTROLOGER,
    initiator: 'ASTROLOGER',
  },
  CUSTOMER_NO_SHOW: {
    from: AppointmentStatus.CONFIRMED,
    to: AppointmentStatus.NO_SHOW_CUSTOMER,
    initiator: 'VERIFIED_ATTENDANCE_REPORT',
  },
  ASTROLOGER_NO_SHOW: {
    from: AppointmentStatus.CONFIRMED,
    to: AppointmentStatus.NO_SHOW_ASTROLOGER,
    initiator: 'VERIFIED_ATTENDANCE_REPORT',
  },
  BOTH_NO_SHOW: {
    from: AppointmentStatus.CONFIRMED,
    to: AppointmentStatus.NO_SHOW_BOTH,
    initiator: 'VERIFIED_ATTENDANCE_REPORT',
  },
};

export const APPOINTMENT_TRANSITIONS = ALLOWED;

/** Agreed V1 join window around the scheduled start. */
export const JOIN_WINDOW_BEFORE_START_MINUTES = 10;
export const JOIN_GRACE_AFTER_START_MINUTES = 10;

/**
 * Ordinary cancellation (customer or astrologer) is allowed only STRICTLY
 * BEFORE the scheduled start.
 *
 *   now < start - 10 min      before the join window            → allowed
 *   start - 10 min ≤ now < start  join window open, not started → allowed
 *   start ≤ now ≤ start + 10 min  late-grace period             → rejected
 *   now > start + 10 min      after the grace period            → rejected
 *
 * From the scheduled start onwards the outcome must come from trusted session
 * or attendance evidence (start event, no-show report). Cancelling then would
 * pre-empt that evidence, and the rule "cancel at any time" refers to any time
 * BEFORE the appointment. Elapsed time alone is never treated as absence.
 */
export function isCancellationAllowedAt(startAt: Date, now: Date): boolean {
  return now.getTime() < startAt.getTime();
}

/**
 * Statuses whose appointment (and accepted proposal) no longer occupy the
 * astrologer's calendar. PAYMENT_EXPIRED is deliberately absent: its existing
 * behaviour (re-checkout allowed) is unchanged.
 */
export const SLOT_RELEASED_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.CANCELLED_BY_CUSTOMER,
  AppointmentStatus.CANCELLED_BY_ASTROLOGER,
  AppointmentStatus.NO_SHOW_CUSTOMER,
  AppointmentStatus.NO_SHOW_ASTROLOGER,
  AppointmentStatus.NO_SHOW_BOTH,
  AppointmentStatus.COMPLETED,
];

/** Statuses a new checkout must never revive. */
export const CHECKOUT_BLOCKED_STATUSES: AppointmentStatus[] = [
  ...SLOT_RELEASED_STATUSES,
  AppointmentStatus.IN_PROGRESS,
];

export function assertAppointmentTransition(
  current: AppointmentStatus,
  transition: AppointmentTransition,
): AppointmentStatus {
  const rule = ALLOWED[transition];
  if (current !== rule.from) {
    throw new Error(
      `Invalid appointment transition ${transition} from ${current}`,
    );
  }
  return rule.to;
}

/**
 * Pure no-show classification from VERIFIED attendance facts. Returns null
 * when both participants joined (a session should exist, so not a no-show).
 */
export function classifyNoShow(attendance: {
  customerJoined: boolean;
  astrologerJoined: boolean;
}): AppointmentTransition | null {
  if (attendance.customerJoined && attendance.astrologerJoined) return null;
  if (!attendance.customerJoined && !attendance.astrologerJoined) {
    return 'BOTH_NO_SHOW';
  }
  return attendance.customerJoined ? 'ASTROLOGER_NO_SHOW' : 'CUSTOMER_NO_SHOW';
}

/** True when `at` lies inside [start - 10 min, start + 10 min]. */
export function isWithinJoinWindow(startAt: Date, at: Date): boolean {
  const t = at.getTime();
  const s = startAt.getTime();
  return (
    t >= s - JOIN_WINDOW_BEFORE_START_MINUTES * 60_000 &&
    t <= s + JOIN_GRACE_AFTER_START_MINUTES * 60_000
  );
}

/** True once the late-arrival grace period has fully elapsed. */
export function hasJoinGraceElapsed(startAt: Date, now: Date): boolean {
  return (
    now.getTime() > startAt.getTime() + JOIN_GRACE_AFTER_START_MINUTES * 60_000
  );
}

export function isAppointmentHoldActive(
  status: AppointmentStatus,
  reservationExpiresAt: Date,
  now: Date = new Date(),
): boolean {
  return (
    status === AppointmentStatus.PAYMENT_PENDING &&
    reservationExpiresAt.getTime() > now.getTime()
  );
}

export function isAppointmentConfirmed(status: AppointmentStatus): boolean {
  return status === AppointmentStatus.CONFIRMED;
}

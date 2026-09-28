import { AppointmentStatus } from '@prisma/client';

/**
 * Appointment state machine (Phase 5B V1).
 *
 * PAYMENT_PENDING
 *  ├── PAYMENT_SUCCESS → CONFIRMED
 *  └── PAYMENT_TIMEOUT → PAYMENT_EXPIRED
 *
 * CONFIRMED / PAYMENT_EXPIRED / CANCELLED are terminal for V1.
 */
export type AppointmentTransition = 'PAYMENT_SUCCESS' | 'PAYMENT_TIMEOUT';

const ALLOWED: Record<
  AppointmentTransition,
  { from: AppointmentStatus; to: AppointmentStatus }
> = {
  PAYMENT_SUCCESS: {
    from: AppointmentStatus.PAYMENT_PENDING,
    to: AppointmentStatus.CONFIRMED,
  },
  PAYMENT_TIMEOUT: {
    from: AppointmentStatus.PAYMENT_PENDING,
    to: AppointmentStatus.PAYMENT_EXPIRED,
  },
};

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

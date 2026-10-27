import { MIN_BOOKING_LEAD_MINUTES } from '../availability/availability.constants';
import { isNonProductionEnv } from './runtime-safety';

/** Lead time used only when the explicit short-notice test override is active. */
export const SHORT_NOTICE_TEST_LEAD_MINUTES = 5;

/**
 * True only when the env flag is explicitly `true` AND NODE_ENV is an
 * allowlisted non-production value. Fail closed otherwise.
 */
export function isShortNoticeTestAppointmentsEnabled(
  rawFlag: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  return rawFlag === 'true' && isNonProductionEnv(nodeEnv);
}

/**
 * Startup guard: production (or any non-allowlisted NODE_ENV) must reject an
 * enabled override rather than silently ignoring it.
 */
export function assertShortNoticeTestAppointmentsEnv(
  rawFlag: string | undefined,
  nodeEnv: string | undefined,
): void {
  if (rawFlag !== 'true') return;
  if (isNonProductionEnv(nodeEnv)) return;
  throw new Error(
    'Environment validation failed: ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS ' +
      'can only be enabled when NODE_ENV is development or test',
  );
}

/** Effective proposal / booking lead minutes for the current process. */
export function resolveProposalMinLeadMinutes(
  rawFlag: string | undefined,
  nodeEnv: string | undefined,
): number {
  return isShortNoticeTestAppointmentsEnabled(rawFlag, nodeEnv)
    ? SHORT_NOTICE_TEST_LEAD_MINUTES
    : MIN_BOOKING_LEAD_MINUTES;
}

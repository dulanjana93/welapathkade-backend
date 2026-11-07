import {
  MIN_BOOKING_LEAD_MINUTES,
  MIN_PROPOSAL_LEAD_MINUTES,
} from '../availability/availability.constants';
import { isNonProductionEnv } from './runtime-safety';

/**
 * Lead time used only when the explicit short-notice test override is active
 * for public bookable-slot enumeration (not proposal validation).
 */
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

/**
 * Astrologer proposal / acceptance / Confirm & Pay lead minutes.
 * Always {@link MIN_PROPOSAL_LEAD_MINUTES}; the short-notice flag does not
 * change proposal validation (production and non-production alike).
 */
export function resolveProposalMinLeadMinutes(
  _rawFlag?: string | undefined,
  _nodeEnv?: string | undefined,
): number {
  return MIN_PROPOSAL_LEAD_MINUTES;
}

/**
 * Public bookable-slot lead minutes. Defaults to
 * {@link MIN_BOOKING_LEAD_MINUTES}; reduced only under the explicit
 * non-production short-notice test override.
 */
export function resolveBookingMinLeadMinutes(
  rawFlag: string | undefined,
  nodeEnv: string | undefined,
): number {
  return isShortNoticeTestAppointmentsEnabled(rawFlag, nodeEnv)
    ? SHORT_NOTICE_TEST_LEAD_MINUTES
    : MIN_BOOKING_LEAD_MINUTES;
}

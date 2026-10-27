/**
 * Deterministic event ids for internal session lifecycle transitions.
 *
 * These are not client-supplied. Video join and the hard-end completion sweep
 * reuse the same id per appointment so retries stay idempotent.
 */

export function videoJoinSessionStartEventId(appointmentId: string): string {
  return `internal:video-join:${appointmentId}`;
}

export function sessionHardEndEventId(appointmentId: string): string {
  return `internal:session-hard-end:${appointmentId}`;
}

/**
 * Lifecycle input shapes for session start/end and no-show classification.
 *
 * Trust boundary (Phase B3-a.1): these plain inputs are NOT authenticated by
 * type alone. `AppointmentLifecycleService.recordSessionStart`,
 * `recordSessionEnd`, and `recordNoShow` require a live
 * `SessionEvidenceCapability` asserted against a process-local WeakSet.
 *
 * Production trusted capability sources:
 * - `mintInternalSessionLifecycleCapability` — video join SESSION_START and
 *   hard-end SESSION_END sweep only (never HTTP-exposed).
 * - Future authenticated provider adapters (still fail-closed today).
 *
 * Clients cannot supply event times, durations, or capabilities. Provider
 * authentication remains fail-closed in `ProviderAdapterBoundary`.
 *
 * Tests: Jest replaces this capability module with
 * `test/support/session-evidence-test-harness.ts` (unit + e2e setup). That
 * harness is not part of the Nest production build (`tsconfig.build.json`
 * excludes `test/`).
 */

export interface SessionEventInput {
  /** Provider-unique event id. Stored uniquely so one event can apply once. */
  eventId: string;
  appointmentId: string;
  /** When the provider says the event happened (UTC). */
  occurredAt: Date;
}

export interface AttendanceInput {
  appointmentId: string;
  /** Provider-derived: did each participant actually join the room? */
  customerJoined: boolean;
  astrologerJoined: boolean;
}

/**
 * @deprecated Prefer SessionEventInput + SessionEvidenceCapability.
 */
export type VerifiedSessionEvent = SessionEventInput;

/**
 * @deprecated Prefer AttendanceInput + SessionEvidenceCapability.
 */
export type VerifiedAttendanceReport = AttendanceInput;

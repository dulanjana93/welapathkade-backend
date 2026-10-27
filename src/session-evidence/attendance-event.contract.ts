import { BadRequestException } from '@nestjs/common';
import {
  SessionAttendanceEventKind,
  SessionAttendanceParticipantRole,
} from '@prisma/client';

/** Max lengths aligned with Prisma @db.VarChar sizes. */
export const ATTENDANCE_ID_MAX = {
  provider: 64,
  providerEventId: 191,
  providerRoomId: 191,
  appointmentId: 191,
  adapterName: 64,
} as const;

export const ATTENDANCE_EVENT_KINDS = [
  SessionAttendanceEventKind.PARTICIPANT_JOINED,
  SessionAttendanceEventKind.PARTICIPANT_LEFT,
] as const;

export const ATTENDANCE_PARTICIPANT_ROLES = [
  SessionAttendanceParticipantRole.CUSTOMER,
  SessionAttendanceParticipantRole.ASTROLOGER,
] as const;

/**
 * Caller-supplied attendance draft. Must NOT include appointmentId —
 * that is resolved only via trusted server-side room mapping.
 */
export type AttendanceEventDraft = {
  provider: string;
  providerEventId: string;
  providerRoomId: string;
  participantRole: SessionAttendanceParticipantRole | string;
  eventKind: SessionAttendanceEventKind | string;
  /** Provider clock (UTC). Distinguished from server receipt time. */
  providerOccurredAt: Date;
  /** Optional adapter name for audit. Never tokens, URLs, or PII. */
  adapterName?: string;
};

export type ValidatedAttendanceDraft = {
  provider: string;
  providerEventId: string;
  providerRoomId: string;
  participantRole: SessionAttendanceParticipantRole;
  eventKind: SessionAttendanceEventKind;
  providerOccurredAt: Date;
  sourceMeta: { adapter: string } | null;
};

export type ValidatedAttendanceEvent = ValidatedAttendanceDraft & {
  appointmentId: string;
};

/** Immutable fields compared on duplicate provider event id replay. */
export type AttendanceEventIdentityFields = Pick<
  ValidatedAttendanceEvent,
  | 'providerRoomId'
  | 'appointmentId'
  | 'participantRole'
  | 'eventKind'
  | 'providerOccurredAt'
>;

function requireTrimmedId(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException(`${field} is required`);
  }
  if (trimmed.length > max) {
    throw new BadRequestException(`${field} exceeds maximum length ${max}`);
  }
  return trimmed;
}

function requireUtcDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException(`${field} must be a valid Date`);
  }
  return value;
}

/** Validates draft fields. Does not accept or return appointmentId. */
export function validateAttendanceEventDraft(
  draft: AttendanceEventDraft,
): ValidatedAttendanceDraft {
  const provider = requireTrimmedId(
    draft.provider,
    'provider',
    ATTENDANCE_ID_MAX.provider,
  );
  const providerEventId = requireTrimmedId(
    draft.providerEventId,
    'providerEventId',
    ATTENDANCE_ID_MAX.providerEventId,
  );
  const providerRoomId = requireTrimmedId(
    draft.providerRoomId,
    'providerRoomId',
    ATTENDANCE_ID_MAX.providerRoomId,
  );
  const providerOccurredAt = requireUtcDate(
    draft.providerOccurredAt,
    'providerOccurredAt',
  );

  if (
    !ATTENDANCE_PARTICIPANT_ROLES.includes(
      draft.participantRole as SessionAttendanceParticipantRole,
    )
  ) {
    throw new BadRequestException(
      'participantRole must be CUSTOMER or ASTROLOGER',
    );
  }
  if (
    !ATTENDANCE_EVENT_KINDS.includes(
      draft.eventKind as SessionAttendanceEventKind,
    )
  ) {
    throw new BadRequestException(
      'eventKind must be PARTICIPANT_JOINED or PARTICIPANT_LEFT',
    );
  }

  let sourceMeta: { adapter: string } | null = null;
  if (draft.adapterName !== undefined && draft.adapterName !== null) {
    const adapter = requireTrimmedId(
      draft.adapterName,
      'adapterName',
      ATTENDANCE_ID_MAX.adapterName,
    );
    sourceMeta = { adapter };
  }

  return {
    provider,
    providerEventId,
    providerRoomId,
    participantRole: draft.participantRole as SessionAttendanceParticipantRole,
    eventKind: draft.eventKind as SessionAttendanceEventKind,
    providerOccurredAt,
    sourceMeta,
  };
}

export function attachMappedAppointment(
  draft: ValidatedAttendanceDraft,
  appointmentId: string,
): ValidatedAttendanceEvent {
  return {
    ...draft,
    appointmentId: requireTrimmedId(
      appointmentId,
      'appointmentId',
      ATTENDANCE_ID_MAX.appointmentId,
    ),
  };
}

/**
 * Duplicate policy: same provider event id is a DUPLICATE only when room,
 * appointment, role, kind, and providerOccurredAt all match. receivedAt is
 * ignored (legitimate redelivery arrives later).
 */
export function isSameAttendanceEventIdentity(
  existing: AttendanceEventIdentityFields,
  incoming: AttendanceEventIdentityFields,
): boolean {
  return (
    existing.providerRoomId === incoming.providerRoomId &&
    existing.appointmentId === incoming.appointmentId &&
    existing.participantRole === incoming.participantRole &&
    existing.eventKind === incoming.eventKind &&
    existing.providerOccurredAt.getTime() ===
      incoming.providerOccurredAt.getTime()
  );
}

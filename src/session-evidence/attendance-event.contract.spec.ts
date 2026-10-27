import { BadRequestException } from '@nestjs/common';
import {
  SessionAttendanceEventKind,
  SessionAttendanceParticipantRole,
} from '@prisma/client';
import {
  ATTENDANCE_ID_MAX,
  attachMappedAppointment,
  isSameAttendanceEventIdentity,
  validateAttendanceEventDraft,
} from './attendance-event.contract';

describe('attendance event contract', () => {
  const valid = {
    provider: 'future-provider',
    providerEventId: 'evt-1',
    providerRoomId: 'room-1',
    participantRole: SessionAttendanceParticipantRole.CUSTOMER,
    eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
    providerOccurredAt: new Date('2026-10-01T04:30:00.000Z'),
    adapterName: 'test-adapter',
  };

  it('accepts a well-formed draft without appointmentId', () => {
    expect(validateAttendanceEventDraft(valid)).toMatchObject({
      provider: 'future-provider',
      providerEventId: 'evt-1',
      sourceMeta: { adapter: 'test-adapter' },
    });
  });

  it.each([
    ['provider', { provider: '' }],
    ['providerEventId', { providerEventId: '   ' }],
    ['providerRoomId', { providerRoomId: '' }],
  ])('rejects missing %s', (_field, override) => {
    expect(() =>
      validateAttendanceEventDraft({ ...valid, ...override }),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid timestamps', () => {
    expect(() =>
      validateAttendanceEventDraft({
        ...valid,
        providerOccurredAt: new Date('not-a-date'),
      }),
    ).toThrow(/providerOccurredAt/);
  });

  it('rejects unsupported event kinds and participant roles', () => {
    expect(() =>
      validateAttendanceEventDraft({
        ...valid,
        eventKind: 'SESSION_STARTED',
      }),
    ).toThrow(/eventKind/);
    expect(() =>
      validateAttendanceEventDraft({
        ...valid,
        participantRole: 'ADMIN',
      }),
    ).toThrow(/participantRole/);
  });

  it('rejects oversized identifiers', () => {
    expect(() =>
      validateAttendanceEventDraft({
        ...valid,
        provider: 'x'.repeat(ATTENDANCE_ID_MAX.provider + 1),
      }),
    ).toThrow(/provider/);
  });

  it('duplicate identity ignores receivedAt and compares immutable fields', () => {
    const base = attachMappedAppointment(
      validateAttendanceEventDraft(valid),
      'apt-1',
    );
    expect(
      isSameAttendanceEventIdentity(base, {
        ...base,
        providerOccurredAt: new Date(base.providerOccurredAt),
      }),
    ).toBe(true);
    expect(
      isSameAttendanceEventIdentity(base, {
        ...base,
        eventKind: SessionAttendanceEventKind.PARTICIPANT_LEFT,
      }),
    ).toBe(false);
  });
});

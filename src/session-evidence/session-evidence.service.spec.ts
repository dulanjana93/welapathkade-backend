import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  Prisma,
  SessionAttendanceEventKind,
  SessionAttendanceParticipantRole,
} from '@prisma/client';
import { ProviderAdapterBoundary } from './provider-adapter.boundary';
import { FailClosedRoomAppointmentMappingResolver } from './room-mapping';
import { SessionEvidenceService } from './session-evidence.service';
import {
  createTestSessionEvidenceCapability,
  TestRoomAppointmentMappingResolver,
} from '../../test/support/session-evidence-test-harness';
import type { SessionEvidenceCapability } from './capability';

describe('SessionEvidenceService', () => {
  const occurredAt = new Date('2026-10-01T04:30:00.000Z');
  const receivedAt = new Date('2026-10-01T04:31:00.000Z');

  const createdRow = {
    id: 'ev-1',
    provider: 'future-provider',
    providerEventId: 'evt-1',
    providerRoomId: 'room-1',
    appointmentId: 'apt-1',
    participantRole: SessionAttendanceParticipantRole.CUSTOMER,
    eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
    providerOccurredAt: occurredAt,
    receivedAt,
    sourceMeta: { adapter: 'test' },
    createdAt: receivedAt,
  };

  const prisma = {
    appointment: {
      findUnique: jest.fn(),
    },
    sessionAttendanceEvidence: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    astrologerReliabilityIncident: {
      count: jest.fn(),
    },
  };

  const mapping = new TestRoomAppointmentMappingResolver({
    'future-provider::room-1': 'apt-1',
  });

  const service = new SessionEvidenceService(prisma as never, mapping);

  const baseInput = {
    provider: 'future-provider',
    providerEventId: 'evt-1',
    providerRoomId: 'room-1',
    participantRole: SessionAttendanceParticipantRole.CUSTOMER,
    eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
    providerOccurredAt: occurredAt,
    adapterName: 'test',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'apt-1',
      status: AppointmentStatus.CONFIRMED,
    });
    prisma.sessionAttendanceEvidence.create.mockResolvedValue(createdRow);
  });

  it('rejects forged capabilities', async () => {
    const forged = { source: 'TEST_HARNESS' } as SessionEvidenceCapability;
    await expect(
      service.recordAttendanceEvent(forged, baseInput, receivedAt),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.sessionAttendanceEvidence.create).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied appointmentId (mapping is authoritative)', async () => {
    await expect(
      service.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        { ...baseInput, appointmentId: 'apt-other' } as never,
        receivedAt,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.sessionAttendanceEvidence.create).not.toHaveBeenCalled();
  });

  it('rejects unknown room mappings (cannot attach to an arbitrary appointment)', async () => {
    await expect(
      service.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        { ...baseInput, providerRoomId: 'room-unknown' },
        receivedAt,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.sessionAttendanceEvidence.create).not.toHaveBeenCalled();
  });

  it('records a join event without mutating appointment lifecycle fields', async () => {
    const result = await service.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      baseInput,
      receivedAt,
    );
    expect(result.status).toBe('CREATED');
    expect(prisma.sessionAttendanceEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'future-provider',
        providerEventId: 'evt-1',
        providerOccurredAt: occurredAt,
        receivedAt,
        appointmentId: 'apt-1',
      }),
    });
    expect(Object.keys(prisma.appointment)).toEqual(['findUnique']);
  });

  it('is idempotent for an exact duplicate provider event id', async () => {
    prisma.sessionAttendanceEvidence.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.sessionAttendanceEvidence.findUnique.mockResolvedValue(createdRow);

    const result = await service.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      baseInput,
      new Date(receivedAt.getTime() + 60_000),
    );
    expect(result.status).toBe('DUPLICATE');
    expect(result.evidence.id).toBe('ev-1');
  });

  it('rejects conflicting payloads that reuse the same event id', async () => {
    prisma.sessionAttendanceEvidence.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.sessionAttendanceEvidence.findUnique.mockResolvedValue(createdRow);

    await expect(
      service.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        {
          ...baseInput,
          eventKind: SessionAttendanceEventKind.PARTICIPANT_LEFT,
        },
        receivedAt,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rethrows non-duplicate database errors', async () => {
    prisma.sessionAttendanceEvidence.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        baseInput,
        receivedAt,
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('stores two distinct events for the same appointment', async () => {
    prisma.sessionAttendanceEvidence.create
      .mockResolvedValueOnce(createdRow)
      .mockResolvedValueOnce({
        ...createdRow,
        id: 'ev-2',
        providerEventId: 'evt-2',
        eventKind: SessionAttendanceEventKind.PARTICIPANT_LEFT,
      });

    const first = await service.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      baseInput,
      receivedAt,
    );
    const second = await service.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      {
        ...baseInput,
        providerEventId: 'evt-2',
        eventKind: SessionAttendanceEventKind.PARTICIPANT_LEFT,
        providerOccurredAt: new Date(occurredAt.getTime() + 60_000),
      },
      new Date(receivedAt.getTime() + 60_000),
    );
    expect(first.status).toBe('CREATED');
    expect(second.status).toBe('CREATED');
    expect(prisma.sessionAttendanceEvidence.create).toHaveBeenCalledTimes(2);
  });

  it('retains a delayed event for a terminal appointment without updating it', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'apt-1',
      status: AppointmentStatus.CANCELLED_BY_CUSTOMER,
    });
    const result = await service.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      baseInput,
      receivedAt,
    );
    expect(result.status).toBe('CREATED');
    expect(prisma.appointment.findUnique).toHaveBeenCalledWith({
      where: { id: 'apt-1' },
      select: { id: true },
    });
  });

  it('rejects when the mapped appointment row is missing', async () => {
    prisma.appointment.findUnique.mockResolvedValue(null);
    await expect(
      service.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        baseInput,
        receivedAt,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.sessionAttendanceEvidence.create).not.toHaveBeenCalled();
  });
});

describe('ProviderAdapterBoundary fail-closed auth', () => {
  const evidence = {
    recordAttendanceEvent: jest.fn(),
  };
  const boundary = new ProviderAdapterBoundary(
    evidence as never,
    new FailClosedRoomAppointmentMappingResolver(),
  );

  it('does not report provider authentication as implemented', () => {
    expect(boundary.isProviderAuthenticationImplemented()).toBe(false);
  });

  it('rejects authenticateProviderCallback', async () => {
    await expect(
      boundary.authenticateProviderCallback({
        provider: 'future-provider',
        headers: {},
        rawBody: Buffer.from('{}'),
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects unknown room mapping', async () => {
    await expect(
      boundary.resolveAppointmentForRoom('future-provider', 'room-x'),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses submitAuthenticatedAttendanceEvent while auth is unimplemented', async () => {
    await expect(
      boundary.submitAuthenticatedAttendanceEvent({
        adapterName: 'future',
        event: {
          provider: 'future-provider',
          providerEventId: 'evt-1',
          providerRoomId: 'room-1',
          participantRole: SessionAttendanceParticipantRole.CUSTOMER,
          eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
          providerOccurredAt: new Date(),
        },
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(evidence.recordAttendanceEvent).not.toHaveBeenCalled();
  });
});

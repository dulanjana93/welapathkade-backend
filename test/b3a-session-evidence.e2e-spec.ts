import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppointmentStatus,
  AstrologerProfileStatus,
  SessionAttendanceEventKind,
  SessionAttendanceParticipantRole,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { NotificationService } from '../src/notifications/notification.service';
import { AppointmentLifecycleService } from '../src/payments/appointment-lifecycle.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { isSessionEvidenceProviderAuthImplemented } from '../src/session-evidence/capability';
import { ProviderAdapterBoundary } from '../src/session-evidence/provider-adapter.boundary';
import { SessionEvidenceService } from '../src/session-evidence/session-evidence.service';
import {
  createTestSessionEvidenceCapability,
  TestRoomAppointmentMappingResolver,
} from './support/session-evidence-test-harness';
import { resetE2eDatabase, resetE2eRedisOtps } from './e2e-cleanup';

jest.setTimeout(90_000);

/**
 * Persistence coverage requires migration
 * `20261010140000_phase_b3a_session_attendance_evidence` on the dedicated
 * test database (`welapathkade_test`).
 *
 * Prerequisite (do not run as part of B3-a.1 remediation against other DBs):
 *   npm run test:e2e:migrate
 *
 * If the table is absent, the persistence test FAILS with that message
 * (it does not silently pass).
 */
describe('Phase B3-a session attendance evidence (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let evidence: SessionEvidenceService;
  let boundary: ProviderAdapterBoundary;
  let lifecycle: AppointmentLifecycleService;
  let tableReady = false;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NotificationService)
      .useValue({
        notifyUser: jest.fn().mockResolvedValue(null),
        notifyAstrologerProfile: jest.fn().mockResolvedValue(null),
        deliverAfterCommit: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    evidence = app.get(SessionEvidenceService);
    boundary = app.get(ProviderAdapterBoundary);
    lifecycle = app.get(AppointmentLifecycleService);

    try {
      await prisma.sessionAttendanceEvidence.findFirst({ take: 1 });
      tableReady = true;
    } catch {
      tableReady = false;
    }
  });

  beforeEach(async () => {
    await resetE2eDatabase(prisma);
    await resetE2eRedisOtps(redis);
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes no public HTTP route for attendance evidence or verified session events', async () => {
    const http = () => request(app.getHttpServer());
    for (const path of [
      '/session-evidence',
      '/session-evidence/events',
      '/attendance',
      '/attendance/events',
      '/consultations/x/appointment/attendance',
      '/consultations/x/appointment/join',
    ]) {
      await http().post(path).send({ appointmentId: 'apt-1' }).expect(404);
    }
  });

  it('does not report provider authentication as implemented', () => {
    expect(isSessionEvidenceProviderAuthImplemented()).toBe(false);
    expect(boundary.isProviderAuthenticationImplemented()).toBe(false);
  });

  it('fails closed on provider authentication and production submit path', async () => {
    await expect(
      boundary.authenticateProviderCallback({
        provider: 'future-provider',
        headers: {},
        rawBody: Buffer.from('{}'),
      }),
    ).rejects.toThrow(/No video session provider authenticator/);

    await expect(
      boundary.submitAuthenticatedAttendanceEvent({
        adapterName: 'e2e',
        event: {
          provider: 'future-provider',
          providerEventId: 'evt-1',
          providerRoomId: 'room-1',
          participantRole: SessionAttendanceParticipantRole.CUSTOMER,
          eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
          providerOccurredAt: new Date(),
        },
      }),
    ).rejects.toThrow(/not implemented/);
  });

  it('rejects a forged capability on lifecycle session start', async () => {
    await expect(
      lifecycle.recordSessionStart(
        { source: 'AUTHENTICATED_ADAPTER' } as never,
        {
          eventId: 'evt-forged',
          appointmentId: 'missing',
          occurredAt: new Date(),
        },
      ),
    ).rejects.toThrow(/live session-evidence capability/);
  });

  it('rejects a forged capability on evidence recording', async () => {
    await expect(
      evidence.recordAttendanceEvent({ source: 'TEST_HARNESS' } as never, {
        provider: 'future-provider',
        providerEventId: 'evt-1',
        providerRoomId: 'room-1',
        participantRole: SessionAttendanceParticipantRole.CUSTOMER,
        eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
        providerOccurredAt: new Date(),
      }),
    ).rejects.toThrow(/live session-evidence capability/);
  });

  it('records join/leave evidence with mapping, duplicates, conflicts, and no appointment mutation', async () => {
    if (!tableReady) {
      throw new Error(
        'B3-a persistence E2E requires SessionAttendanceEvidence on welapathkade_test. ' +
          'Apply migration 20261010140000_phase_b3a_session_attendance_evidence via: ' +
          'npm run test:e2e:migrate ' +
          '(uses test/load-env-test.cjs; do not migrate development DB from this task).',
      );
    }

    const startAt = new Date(Date.now() + 2 * 86_400_000);
    const customer = await prisma.user.create({
      data: {
        phone: '+94776672001',
        name: 'Evidence Customer',
        role: 'PUBLIC',
        referralCode: `EVC${Date.now()}`,
      },
    });
    const astrologerUser = await prisma.user.create({
      data: {
        phone: '+94776673001',
        name: 'Evidence Astrologer',
        role: 'ASTROLOGER',
        referralCode: `EVA${Date.now()}`,
      },
    });
    const profile = await prisma.astrologerProfile.create({
      data: {
        userId: astrologerUser.id,
        displayName: 'Evidence Astro',
        status: AstrologerProfileStatus.ACTIVE,
        city: 'Colombo',
      },
    });
    const serviceRow = await prisma.service.create({
      data: {
        code: `EVID_${Date.now()}`,
        nameEn: 'Evid Service',
        nameSi: 'Evid Service',
        minPrice: 500,
        maxPrice: 5000,
      },
    });
    const asvc = await prisma.astrologerService.create({
      data: {
        astrologerId: profile.id,
        serviceId: serviceRow.id,
        price: 1000,
      },
    });
    const consultation = await prisma.consultation.create({
      data: {
        customerId: customer.id,
        astrologerId: profile.id,
        astrologerServiceId: asvc.id,
        serviceId: serviceRow.id,
        serviceNameSi: serviceRow.nameSi,
        serviceNameEn: serviceRow.nameEn,
        status: 'ACCEPTED',
        requestedPrice: 1000,
        preferredStartAt: startAt,
        submittedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const proposal = await prisma.consultationProposal.create({
      data: {
        consultationId: consultation.id,
        proposedStartAt: startAt,
        proposedEndAt: new Date(startAt.getTime() + 30 * 60_000),
        durationMinutes: 30,
        status: 'ACCEPTED',
      },
    });
    const appointment = await prisma.appointment.create({
      data: {
        consultationId: consultation.id,
        proposalId: proposal.id,
        customerId: customer.id,
        astrologerId: profile.id,
        startAt,
        endAt: new Date(startAt.getTime() + 30 * 60_000),
        durationMinutes: 30,
        status: AppointmentStatus.CONFIRMED,
        amount: 1000,
        reservationExpiresAt: new Date(Date.now() + 1_800_000),
        confirmedAt: new Date(),
      },
    });

    // Re-bind mapping to the created appointment (override used PLACEHOLDER).
    const mappedEvidence = new SessionEvidenceService(
      prisma,
      new TestRoomAppointmentMappingResolver({
        'future-provider::room-1': appointment.id,
      }),
    );

    const before = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });

    const join = await mappedEvidence.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      {
        provider: 'future-provider',
        providerEventId: 'evt-join-1',
        providerRoomId: 'room-1',
        participantRole: SessionAttendanceParticipantRole.CUSTOMER,
        eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
        providerOccurredAt: startAt,
        adapterName: 'e2e-harness',
      },
      new Date(startAt.getTime() + 5_000),
    );
    const leave = await mappedEvidence.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      {
        provider: 'future-provider',
        providerEventId: 'evt-leave-1',
        providerRoomId: 'room-1',
        participantRole: SessionAttendanceParticipantRole.CUSTOMER,
        eventKind: SessionAttendanceEventKind.PARTICIPANT_LEFT,
        providerOccurredAt: new Date(startAt.getTime() + 60_000),
        adapterName: 'e2e-harness',
      },
      new Date(startAt.getTime() + 65_000),
    );
    const replay = await mappedEvidence.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      {
        provider: 'future-provider',
        providerEventId: 'evt-join-1',
        providerRoomId: 'room-1',
        participantRole: SessionAttendanceParticipantRole.CUSTOMER,
        eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
        providerOccurredAt: startAt,
      },
      new Date(startAt.getTime() + 120_000),
    );

    expect(join.status).toBe('CREATED');
    expect(leave.status).toBe('CREATED');
    expect(replay.status).toBe('DUPLICATE');
    expect(join.evidence.appointmentId).toBe(appointment.id);
    expect(join.evidence.receivedAt.getTime()).toBe(startAt.getTime() + 5_000);

    await expect(
      mappedEvidence.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        {
          provider: 'future-provider',
          providerEventId: 'evt-join-1',
          providerRoomId: 'room-1',
          participantRole: SessionAttendanceParticipantRole.ASTROLOGER,
          eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
          providerOccurredAt: startAt,
        },
      ),
    ).rejects.toThrow(/conflicting attendance content/);

    await expect(
      mappedEvidence.recordAttendanceEvent(
        createTestSessionEvidenceCapability(),
        {
          provider: 'future-provider',
          providerEventId: 'evt-orphan-room',
          providerRoomId: 'room-unknown',
          participantRole: SessionAttendanceParticipantRole.CUSTOMER,
          eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
          providerOccurredAt: startAt,
        },
      ),
    ).rejects.toThrow(/No appointment mapping/);

    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(after.status).toBe(before.status);
    expect(after.refundObligation).toBe(before.refundObligation);
    expect(after.manualReviewRequired).toBe(before.manualReviewRequired);
    expect(await prisma.astrologerReliabilityIncident.count()).toBe(0);

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: AppointmentStatus.CANCELLED_BY_CUSTOMER },
    });
    const delayed = await mappedEvidence.recordAttendanceEvent(
      createTestSessionEvidenceCapability(),
      {
        provider: 'future-provider',
        providerEventId: 'evt-late-join',
        providerRoomId: 'room-1',
        participantRole: SessionAttendanceParticipantRole.ASTROLOGER,
        eventKind: SessionAttendanceEventKind.PARTICIPANT_JOINED,
        providerOccurredAt: new Date(startAt.getTime() + 180_000),
      },
    );
    expect(delayed.status).toBe('CREATED');
    const terminal = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(terminal.status).toBe(AppointmentStatus.CANCELLED_BY_CUSTOMER);
    expect(await prisma.sessionAttendanceEvidence.count()).toBe(3);
  });
});

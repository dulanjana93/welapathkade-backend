import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppointmentStatus, UserRole } from '@prisma/client';
import { videoJoinSessionStartEventId } from '../session-evidence/internal-lifecycle-events';
import { AgoraTokenService } from './agora-token.service';
import { VideoSessionService } from './video-session.service';

const TEST_APP_ID = 'a1b2c3d4e5f64789a0b1c2d3e4f50617';
const TEST_APP_CERT = 'f1e2d3c4b5a697887766554433221100';

function mockConfigService() {
  return {
    get: (key: string) => {
      if (key === 'app.agoraAppId') return TEST_APP_ID;
      if (key === 'app.agoraAppCertificate') return TEST_APP_CERT;
      return undefined;
    },
  };
}

describe('VideoSessionService', () => {
  const startAt = new Date('2026-10-10T12:00:00.000Z');
  const endAt = new Date('2026-10-10T12:30:00.000Z');
  const now = new Date('2026-10-10T11:55:00.000Z');

  const appointment: {
    id: string;
    status: AppointmentStatus;
    startAt: Date;
    endAt: Date;
    customerId: string;
    astrologerId: string;
  } = {
    id: 'apt-1',
    status: AppointmentStatus.CONFIRMED,
    startAt,
    endAt,
    customerId: 'user-customer',
    astrologerId: 'astro-profile-1',
  };

  const customer = {
    id: 'user-customer',
    role: UserRole.PUBLIC,
  } as never;

  const astrologerUser = {
    id: 'user-astro',
    role: UserRole.ASTROLOGER,
  } as never;

  function build(overrides?: {
    appointment?: typeof appointment | null;
    profileId?: string | null;
    agoraConfigured?: boolean;
  }) {
    const prisma = {
      appointment: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            overrides && 'appointment' in overrides
              ? overrides.appointment
              : appointment,
          ),
      },
      astrologerProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            overrides?.profileId === null
              ? null
              : { id: overrides?.profileId ?? 'astro-profile-1' },
          ),
      },
    };
    const lifecycle = {
      recordSessionStart: jest.fn().mockResolvedValue({}),
      recordSessionEnd: jest.fn().mockResolvedValue({}),
    };
    const agora =
      overrides?.agoraConfigured === false
        ? ({
            issueRtcCredentials: () => {
              throw new ServiceUnavailableException(
                'Agora video credentials are not configured on this server',
              );
            },
          } as unknown as AgoraTokenService)
        : new AgoraTokenService(mockConfigService() as never);
    return {
      prisma,
      lifecycle,
      service: new VideoSessionService(
        prisma as never,
        agora,
        lifecycle as never,
      ),
    };
  }

  it('issues credentials for the owning customer inside the join window', async () => {
    const { service, prisma, lifecycle } = build();
    const creds = await service.issueCredentialsForConsultation(
      customer,
      'consult-1',
      now,
    );
    expect(prisma.appointment.findFirst).toHaveBeenCalled();
    expect(lifecycle.recordSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'INTERNAL_LIFECYCLE' }),
      {
        eventId: videoJoinSessionStartEventId('apt-1'),
        appointmentId: 'apt-1',
        occurredAt: now,
      },
    );
    expect(creds.participantRole).toBe('CUSTOMER');
    expect(creds.appId).toBe(TEST_APP_ID);
    expect(JSON.stringify(creds)).not.toContain(TEST_APP_CERT);
  });

  it('issues credentials for the assigned astrologer on the same channel', async () => {
    const { service, lifecycle } = build();
    const customerCreds = await service.issueCredentialsForConsultation(
      customer,
      'consult-1',
      now,
    );
    const astroCreds = await service.issueCredentialsForConsultation(
      astrologerUser,
      'consult-1',
      now,
    );
    expect(astroCreds.participantRole).toBe('ASTROLOGER');
    expect(astroCreds.channelName).toBe(customerCreds.channelName);
    expect(astroCreds.uid).not.toBe(customerCreds.uid);
    expect(lifecycle.recordSessionStart).toHaveBeenCalledTimes(2);
  });

  it('does not re-start an already IN_PROGRESS appointment', async () => {
    const { service, lifecycle } = build({
      appointment: {
        ...appointment,
        status: AppointmentStatus.IN_PROGRESS,
      },
    });
    await service.issueCredentialsForConsultation(customer, 'consult-1', now);
    expect(lifecycle.recordSessionStart).not.toHaveBeenCalled();
  });

  it('hides wrong ownership as not found and never starts the session', async () => {
    const { service, lifecycle } = build();
    const other = { id: 'other-customer', role: UserRole.PUBLIC } as never;
    await expect(
      service.issueCredentialsForConsultation(other, 'consult-1', now),
    ).rejects.toThrow(NotFoundException);
    expect(lifecycle.recordSessionStart).not.toHaveBeenCalled();
  });

  it('rejects unassigned astrologer as not found', async () => {
    const { service, lifecycle } = build({ profileId: 'astro-other' });
    await expect(
      service.issueCredentialsForConsultation(astrologerUser, 'consult-1', now),
    ).rejects.toThrow(NotFoundException);
    expect(lifecycle.recordSessionStart).not.toHaveBeenCalled();
  });

  it('rejects admin / unsupported roles', async () => {
    const { service } = build();
    const admin = { id: 'admin-1', role: UserRole.ADMIN } as never;
    await expect(
      service.issueCredentialsForConsultation(admin, 'consult-1', now),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects ineligible appointment statuses', async () => {
    for (const status of [
      AppointmentStatus.PAYMENT_PENDING,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
      AppointmentStatus.NO_SHOW_CUSTOMER,
    ]) {
      const { service, lifecycle } = build({
        appointment: { ...appointment, status },
      });
      await expect(
        service.issueCredentialsForConsultation(customer, 'consult-1', now),
      ).rejects.toThrow(ConflictException);
      expect(lifecycle.recordSessionStart).not.toHaveBeenCalled();
    }
  });

  it('rejects CONFIRMED appointments outside the join window', async () => {
    const { service, lifecycle } = build();
    await expect(
      service.issueCredentialsForConsultation(
        customer,
        'consult-1',
        new Date('2026-10-10T11:00:00.000Z'),
      ),
    ).rejects.toThrow(ConflictException);
    expect(lifecycle.recordSessionStart).not.toHaveBeenCalled();
  });

  it('allows IN_PROGRESS after the grace period while still before hard end', async () => {
    const { service, lifecycle } = build({
      appointment: {
        ...appointment,
        status: AppointmentStatus.IN_PROGRESS,
      },
    });
    const creds = await service.issueCredentialsForConsultation(
      customer,
      'consult-1',
      new Date('2026-10-10T12:20:00.000Z'),
    );
    expect(creds.token.length).toBeGreaterThan(20);
    expect(lifecycle.recordSessionStart).not.toHaveBeenCalled();
  });

  it('fails closed when Agora is not configured', async () => {
    const { service } = build({ agoraConfigured: false });
    await expect(
      service.issueCredentialsForConsultation(customer, 'consult-1', now),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('returns not found when no appointment exists', async () => {
    const { service } = build({ appointment: null });
    await expect(
      service.issueCredentialsForConsultation(customer, 'consult-1', now),
    ).rejects.toThrow(NotFoundException);
  });

  it('renewal returns the same channel and uid for the same participant', async () => {
    const { service } = build({
      appointment: {
        ...appointment,
        status: AppointmentStatus.IN_PROGRESS,
      },
    });
    const first = await service.issueCredentialsForConsultation(
      customer,
      'consult-1',
      now,
    );
    const second = await service.issueCredentialsForConsultation(
      customer,
      'consult-1',
      new Date(now.getTime() + 60_000),
    );
    expect(second.channelName).toBe(first.channelName);
    expect(second.uid).toBe(first.uid);
    expect(second.token).not.toBe(first.token);
  });
});

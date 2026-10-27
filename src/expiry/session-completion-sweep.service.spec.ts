import { AppointmentStatus } from '@prisma/client';
import { sessionHardEndEventId } from '../session-evidence/internal-lifecycle-events';
import { SessionCompletionSweepService } from './session-completion-sweep.service';

describe('SessionCompletionSweepService', () => {
  const now = new Date('2026-10-10T12:40:00.000Z');
  const startedAt = new Date('2026-10-10T12:00:00.000Z');

  function build(rows: Array<{ id: string; sessionStartedAt: Date | null }>) {
    const prisma = {
      appointment: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
    const lifecycle = {
      recordSessionEnd: jest.fn().mockResolvedValue({}),
    };
    return {
      prisma,
      lifecycle,
      service: new SessionCompletionSweepService(
        prisma as never,
        lifecycle as never,
      ),
    };
  }

  it('completes due IN_PROGRESS appointments via SESSION_END', async () => {
    const { service, prisma, lifecycle } = build([
      { id: 'apt-1', sessionStartedAt: startedAt },
      { id: 'apt-2', sessionStartedAt: startedAt },
    ]);

    const result = await service.completeDueSessions(now);

    expect(prisma.appointment.findMany).toHaveBeenCalledWith({
      where: {
        status: AppointmentStatus.IN_PROGRESS,
        sessionStartedAt: { not: null },
        endAt: { lte: new Date('2026-10-10T12:35:00.000Z') },
      },
      select: { id: true, sessionStartedAt: true },
      take: 100,
      orderBy: { endAt: 'asc' },
    });
    expect(lifecycle.recordSessionEnd).toHaveBeenCalledTimes(2);
    expect(lifecycle.recordSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'INTERNAL_LIFECYCLE' }),
      {
        eventId: sessionHardEndEventId('apt-1'),
        appointmentId: 'apt-1',
        occurredAt: now,
      },
    );
    expect(result).toEqual({ completed: 2, errors: [] });
  });

  it('is idempotent when lifecycle returns without error on replay', async () => {
    const { service, lifecycle } = build([
      { id: 'apt-1', sessionStartedAt: startedAt },
    ]);
    await service.completeDueSessions(now);
    await service.completeDueSessions(now);
    expect(lifecycle.recordSessionEnd).toHaveBeenCalledTimes(2);
  });

  it('collects per-appointment failures without blocking others', async () => {
    const { service, lifecycle } = build([
      { id: 'apt-1', sessionStartedAt: startedAt },
      { id: 'apt-2', sessionStartedAt: startedAt },
    ]);
    lifecycle.recordSessionEnd
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce({});

    const result = await service.completeDueSessions(now);
    expect(result.completed).toBe(1);
    expect(result.errors).toEqual(['apt-1: conflict']);
  });

  it('does not invent completions when the query fails', async () => {
    const { service, prisma, lifecycle } = build([]);
    prisma.appointment.findMany.mockRejectedValue(new Error('db down'));
    const result = await service.completeDueSessions(now);
    expect(result).toEqual({ completed: 0, errors: ['query: db down'] });
    expect(lifecycle.recordSessionEnd).not.toHaveBeenCalled();
  });

  it('returns zero when nothing is due', async () => {
    const { service, lifecycle } = build([]);
    const result = await service.completeDueSessions(now);
    expect(result).toEqual({ completed: 0, errors: [] });
    expect(lifecycle.recordSessionEnd).not.toHaveBeenCalled();
  });
});

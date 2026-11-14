import { ConsultationStatus } from '@prisma/client';
import { ExpirySweepService } from './expiry-sweep.service';

describe('ExpirySweepService', () => {
  const now = new Date('2026-10-12T04:00:00.000Z');

  const prisma = {
    consultation: { updateMany: jest.fn() },
  };
  const occupancy = {
    expireDueReservations: jest.fn(),
    expireOrphanedPendingPayments: jest.fn(),
  };
  const sessionCompletion = {
    completeDueSessions: jest.fn(),
  };
  const financialSnapshots = {
    createDueSnapshots: jest.fn(),
  };
  const financialLedger = {
    postDueSnapshots: jest.fn(),
  };
  const attachments = {
    purgeAbandonedUploads: jest.fn().mockResolvedValue(0),
  };
  const service = new ExpirySweepService(
    prisma as never,
    occupancy as never,
    sessionCompletion as never,
    financialSnapshots as never,
    financialLedger as never,
    attachments as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    occupancy.expireDueReservations.mockResolvedValue({
      appointments: 2,
      payments: 2,
      attempts: 3,
    });
    occupancy.expireOrphanedPendingPayments.mockResolvedValue({
      payments: 0,
      attempts: 0,
    });
    prisma.consultation.updateMany.mockResolvedValue({ count: 4 });
    sessionCompletion.completeDueSessions.mockResolvedValue({
      completed: 1,
      errors: [],
    });
    financialSnapshots.createDueSnapshots.mockResolvedValue({
      created: 2,
      skipped: 0,
      errors: [],
    });
    financialLedger.postDueSnapshots.mockResolvedValue({
      posted: 1,
      skipped: 0,
      errors: [],
    });
    attachments.purgeAbandonedUploads.mockResolvedValue(0);
  });

  it('reuses the existing guarded rules and reports counts', async () => {
    const result = await service.runOnce(now);

    expect(occupancy.expireDueReservations).toHaveBeenCalledWith(now);
    expect(occupancy.expireOrphanedPendingPayments).toHaveBeenCalledWith(now);
    expect(sessionCompletion.completeDueSessions).toHaveBeenCalledWith(now);
    expect(financialSnapshots.createDueSnapshots).toHaveBeenCalledWith(now);
    expect(financialLedger.postDueSnapshots).toHaveBeenCalledWith(now);
    expect(prisma.consultation.updateMany).toHaveBeenCalledWith({
      where: {
        status: ConsultationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ConsultationStatus.EXPIRED },
    });
    expect(result).toEqual({
      reservations: 2,
      payments: 2,
      attempts: 3,
      consultations: 4,
      sessionsCompleted: 1,
      financialSnapshotsCreated: 2,
      financialLedgersPosted: 1,
      abandonedUploadsRemoved: 0,
      refundsStarted: 0,
      refundsReconciled: 0,
      chargesReconciled: 0,
      cardRegistrationsFailed: 0,
      errors: [],
    });
  });

  it('runs the payment recovery step even when no hold was flipped this run', async () => {
    occupancy.expireDueReservations.mockResolvedValue({
      appointments: 0,
      payments: 0,
      attempts: 0,
    });
    occupancy.expireOrphanedPendingPayments.mockResolvedValue({
      payments: 1,
      attempts: 1,
    });
    sessionCompletion.completeDueSessions.mockResolvedValue({
      completed: 0,
      errors: [],
    });
    financialSnapshots.createDueSnapshots.mockResolvedValue({
      created: 0,
      skipped: 0,
      errors: [],
    });
    financialLedger.postDueSnapshots.mockResolvedValue({
      posted: 0,
      skipped: 0,
      errors: [],
    });
    const result = await service.runOnce(now);
    expect(result.reservations).toBe(0);
    expect(result.payments).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it('a failing step is reported and never blocks the others (recovers next run)', async () => {
    occupancy.expireDueReservations.mockRejectedValue(new Error('db down'));
    const result = await service.runOnce(now);

    expect(result.errors).toEqual(['reservations: db down']);
    // The remaining steps still ran.
    expect(occupancy.expireOrphanedPendingPayments).toHaveBeenCalled();
    expect(sessionCompletion.completeDueSessions).toHaveBeenCalled();
    expect(financialSnapshots.createDueSnapshots).toHaveBeenCalled();
    expect(financialLedger.postDueSnapshots).toHaveBeenCalled();
    expect(result.consultations).toBe(4);
    expect(result.sessionsCompleted).toBe(1);
    expect(result.financialSnapshotsCreated).toBe(2);
    expect(result.financialLedgersPosted).toBe(1);

    // Next run succeeds.
    occupancy.expireDueReservations.mockResolvedValue({
      appointments: 1,
      payments: 1,
      attempts: 1,
    });
    const next = await service.runOnce(now);
    expect(next.errors).toEqual([]);
    expect(next.reservations).toBe(1);
  });

  it('collects every failure including session completion and snapshots', async () => {
    occupancy.expireDueReservations.mockRejectedValue(new Error('a'));
    occupancy.expireOrphanedPendingPayments.mockRejectedValue(new Error('b'));
    prisma.consultation.updateMany.mockRejectedValue('c');
    sessionCompletion.completeDueSessions.mockRejectedValue(new Error('d'));
    financialSnapshots.createDueSnapshots.mockRejectedValue(new Error('e'));
    financialLedger.postDueSnapshots.mockRejectedValue(new Error('f'));
    const result = await service.runOnce(now);
    expect(result.errors).toEqual([
      'reservations: a',
      'payment recovery: b',
      'consultations: c',
      'sessions: d',
      'financialSnapshots: e',
      'financialLedgers: f',
    ]);
  });

  it('surfaces per-session errors from the completion sweep', async () => {
    sessionCompletion.completeDueSessions.mockResolvedValue({
      completed: 0,
      errors: ['apt-1: conflict'],
    });
    financialSnapshots.createDueSnapshots.mockResolvedValue({
      created: 0,
      skipped: 0,
      errors: [],
    });
    const result = await service.runOnce(now);
    expect(result.sessionsCompleted).toBe(0);
    expect(result.errors).toEqual(['sessions: apt-1: conflict']);
  });

  it('defaults to the current time', async () => {
    const before = Date.now();
    await service.runOnce();
    const used = (occupancy.expireDueReservations.mock.calls[0] as [Date])[0];
    expect(used.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('ExpirySweepService saved-card registration backstop', () => {
  const now = new Date('2026-11-14T04:00:00.000Z');
  const prisma = { consultation: { updateMany: jest.fn() } };
  const occupancy = {
    expireDueReservations: jest.fn(),
    expireOrphanedPendingPayments: jest.fn(),
  };
  const sessions = { completeDueSessions: jest.fn() };
  const snapshots = { createDueSnapshots: jest.fn() };
  const ledger = { postDueSnapshots: jest.fn() };
  const attachments = { purgeAbandonedUploads: jest.fn() };
  const savedCards = { failAbandonedRegistrations: jest.fn() };
  const service = new ExpirySweepService(
    prisma as never,
    occupancy as never,
    sessions as never,
    snapshots as never,
    ledger as never,
    attachments as never,
    undefined,
    undefined,
    savedCards as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.consultation.updateMany.mockResolvedValue({ count: 0 });
    occupancy.expireDueReservations.mockResolvedValue({
      appointments: 0,
      payments: 0,
      attempts: 0,
    });
    occupancy.expireOrphanedPendingPayments.mockResolvedValue({
      payments: 0,
      attempts: 0,
    });
    sessions.completeDueSessions.mockResolvedValue({ completed: 0, errors: [] });
    snapshots.createDueSnapshots.mockResolvedValue({
      created: 0,
      skipped: 0,
      errors: [],
    });
    ledger.postDueSnapshots.mockResolvedValue({ posted: 0, skipped: 0, errors: [] });
    attachments.purgeAbandonedUploads.mockResolvedValue(0);
  });

  it('fails abandoned card registrations and reports the count', async () => {
    savedCards.failAbandonedRegistrations.mockResolvedValue({ failed: 3 });
    const result = await service.runOnce(now);
    expect(savedCards.failAbandonedRegistrations).toHaveBeenCalledWith(now);
    expect(result.cardRegistrationsFailed).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('reports a registration backstop failure without blocking other steps', async () => {
    savedCards.failAbandonedRegistrations.mockRejectedValue(new Error('db down'));
    const result = await service.runOnce(now);
    expect(result.cardRegistrationsFailed).toBe(0);
    expect(result.consultations).toBe(0);
    expect(result.errors).toEqual(['saved-card registrations: db down']);
  });
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma, UserRole } from '@prisma/client';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { createTestSessionEvidenceCapability } from '../../test/support/session-evidence-test-harness';

describe('AppointmentLifecycleService', () => {
  const start = new Date('2026-10-01T04:30:00.000Z');
  const minutes = (m: number) => new Date(start.getTime() + m * 60_000);
  const capability = () => createTestSessionEvidenceCapability();

  const prisma = {
    appointment: { findUnique: jest.fn(), findFirst: jest.fn() },
    astrologerProfile: { findUnique: jest.fn() },
  };
  const tx = {
    appointment: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    consultation: { updateMany: jest.fn() },
    astrologerReliabilityIncident: { upsert: jest.fn() },
  };
  const lockCalls: string[] = [];
  const bookingGuard = {
    withAstrologerLock: jest.fn((id: string, work: (t: unknown) => unknown) => {
      lockCalls.push(id);
      return Promise.resolve(work(tx));
    }),
  };
  const service = new AppointmentLifecycleService(
    prisma as never,
    bookingGuard as never,
  );

  const base = {
    id: 'apt-1',
    consultationId: 'c-1',
    proposalId: 'p-1',
    customerId: 'cust-1',
    astrologerId: 'ap-1',
    startAt: start,
    endAt: minutes(30),
    durationMinutes: 30,
    amount: '1500.00',
    currency: 'LKR',
    reservationExpiresAt: minutes(-60),
    confirmedAt: minutes(-120),
    status: AppointmentStatus.CONFIRMED as AppointmentStatus,
    sessionStartedAt: null as Date | null,
    sessionStartEventId: null as string | null,
    sessionEndEventId: null as string | null,
    payments: [],
  };
  const customer = { id: 'cust-1', role: UserRole.PUBLIC } as never;
  const astrologer = { id: 'user-ap', role: UserRole.ASTROLOGER } as never;

  function setCurrent(overrides: Record<string, unknown> = {}) {
    const row = { ...base, ...overrides };
    prisma.appointment.findUnique.mockResolvedValue({
      astrologerId: row.astrologerId,
    });
    prisma.appointment.findFirst.mockResolvedValue(row);
    tx.appointment.findUnique.mockResolvedValue(row);
    tx.appointment.findUniqueOrThrow.mockResolvedValue(row);
    return row;
  }

  type UpdateCall = { where: unknown; data: Record<string, unknown> };
  const updateData = () =>
    (tx.appointment.updateMany.mock.calls as unknown[][])[0][0] as UpdateCall;

  /** Consultation closed as CANCELLED, never stamped as completed. */
  function expectConsultationClosed() {
    expect(tx.consultation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.consultation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-1', status: 'ACCEPTED' },
      data: { status: 'CANCELLED' },
    });
  }

  // Default clock: one hour before the scheduled start. Only Date is faked so
  // promises/timers behave normally. Boundary tests pass an explicit `now`.
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(start.getTime() - 60 * 60_000),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    lockCalls.length = 0;
    tx.appointment.updateMany.mockResolvedValue({ count: 1 });
    tx.consultation.updateMany.mockResolvedValue({ count: 1 });
    tx.astrologerReliabilityIncident.upsert.mockResolvedValue({});
    prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-1' });
  });

  describe('customer cancellation', () => {
    it('cancels a CONFIRMED appointment with a full refund obligation, even minutes before start', async () => {
      setCurrent();
      await service.cancelByCustomer(customer, 'c-1', ' changed my mind ');
      const call = updateData();
      expect(call.where).toEqual({ id: 'apt-1', status: 'CONFIRMED' });
      expect(call.data).toMatchObject({
        status: AppointmentStatus.CANCELLED_BY_CUSTOMER,
        refundObligation: 'FULL_REFUND_DUE',
        cancelReason: 'changed my mind',
      });
      expect(call.data.refundObligationRecordedAt).toBeInstanceOf(Date);
      expect(lockCalls).toEqual(['ap-1']);
      expectConsultationClosed();
      // No reliability incident for a customer cancellation.
      expect(tx.astrologerReliabilityIncident.upsert).not.toHaveBeenCalled();
    });

    it('is idempotent on repeat', async () => {
      setCurrent({ status: AppointmentStatus.CANCELLED_BY_CUSTOMER });
      await service.cancelByCustomer(customer, 'c-1');
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      AppointmentStatus.PAYMENT_PENDING,
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      AppointmentStatus.NO_SHOW_CUSTOMER,
    ])('rejects cancel from %s', async (status) => {
      setCurrent({ status });
      await expect(service.cancelByCustomer(customer, 'c-1')).rejects.toThrow(
        ConflictException,
      );
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects non-PUBLIC roles', async () => {
      await expect(service.cancelByCustomer(astrologer, 'c-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("hides another customer's appointment", async () => {
      setCurrent();
      await expect(
        service.cancelByCustomer(
          { id: 'someone-else', role: UserRole.PUBLIC } as never,
          'c-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('surfaces a concurrent state change as a conflict', async () => {
      setCurrent();
      tx.appointment.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancelByCustomer(customer, 'c-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('cancellation time boundaries (explicit clock)', () => {
    const MIN = 60_000;
    const at = (offsetMs: number) => new Date(start.getTime() + offsetMs);

    type Case = [string, number, boolean];
    const cases: Case[] = [
      ['a day before the start', -24 * 60 * MIN, true],
      ['before the join window opens', -10 * MIN - 1, true],
      ['exactly when the join window opens', -10 * MIN, true],
      ['inside the join window', -5 * MIN, true],
      ['1 ms before the scheduled start', -1, true],
      ['exactly at the scheduled start', 0, false],
      ['1 ms after the scheduled start', 1, false],
      ['inside the late-grace period', 5 * MIN, false],
      ['exactly at the end of the grace period', 10 * MIN, false],
      ['1 ms after the grace period', 10 * MIN + 1, false],
      ['a day after the start', 24 * 60 * MIN, false],
    ];

    const actors = [
      [
        'customer',
        (now: Date) => service.cancelByCustomer(customer, 'c-1', 'reason', now),
        AppointmentStatus.CANCELLED_BY_CUSTOMER,
      ],
      [
        'astrologer',
        (now: Date) =>
          service.cancelByAstrologer(astrologer, 'c-1', 'reason', now),
        AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      ],
    ] as const;

    describe.each(actors)('%s', (_actor, cancel, target) => {
      it.each(cases)('%s', async (_name, offsetMs, allowed) => {
        setCurrent();
        const now = at(offsetMs);

        if (allowed) {
          await cancel(now);
          const call = updateData();
          expect(call.data).toMatchObject({
            status: target,
            refundObligation: 'FULL_REFUND_DUE',
            cancelledAt: now,
            refundObligationRecordedAt: now,
          });
          expectConsultationClosed();
          return;
        }

        await expect(cancel(now)).rejects.toThrow(ConflictException);
        await expect(cancel(now)).rejects.toThrow(/scheduled start time/);
        // Nothing partial: no appointment update, no refund obligation, no
        // consultation closure, no reliability incident.
        expect(tx.appointment.updateMany).not.toHaveBeenCalled();
        expect(tx.consultation.updateMany).not.toHaveBeenCalled();
        expect(tx.astrologerReliabilityIncident.upsert).not.toHaveBeenCalled();
      });

      it('a rejected late cancellation is never a no-show', async () => {
        setCurrent();
        await expect(cancel(at(30 * MIN))).rejects.toThrow(ConflictException);
        expect(tx.appointment.updateMany).not.toHaveBeenCalled();
      });

      it('an already-cancelled appointment stays idempotent even after the start', async () => {
        setCurrent({ status: target });
        await cancel(at(2 * MIN));
        await cancel(at(2 * 24 * 60 * MIN));
        expect(tx.appointment.updateMany).not.toHaveBeenCalled();
        expect(tx.consultation.updateMany).not.toHaveBeenCalled();
        expect(tx.astrologerReliabilityIncident.upsert).not.toHaveBeenCalled();
      });

      it.each([
        AppointmentStatus.IN_PROGRESS,
        AppointmentStatus.COMPLETED,
        AppointmentStatus.NO_SHOW_CUSTOMER,
        AppointmentStatus.NO_SHOW_ASTROLOGER,
        AppointmentStatus.NO_SHOW_BOTH,
        AppointmentStatus.PAYMENT_PENDING,
      ])('rejects %s even well before the start', async (status) => {
        setCurrent({ status });
        await expect(cancel(at(-60 * MIN))).rejects.toThrow(ConflictException);
        expect(tx.appointment.updateMany).not.toHaveBeenCalled();
        expect(tx.astrologerReliabilityIncident.upsert).not.toHaveBeenCalled();
      });
    });

    it("the other party's cancellation is a different terminal outcome, not a repeat", async () => {
      setCurrent({ status: AppointmentStatus.CANCELLED_BY_ASTROLOGER });
      await expect(
        service.cancelByCustomer(customer, 'c-1', undefined, at(-60 * MIN)),
      ).rejects.toThrow(ConflictException);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('uses the real clock (read under the lock) when none is injected', async () => {
      // beforeEach fakes "now" as one hour before the start.
      setCurrent();
      await service.cancelByCustomer(customer, 'c-1');
      expect(updateData().data.cancelledAt).toEqual(at(-60 * MIN));

      jest.setSystemTime(at(MIN));
      jest.clearAllMocks();
      setCurrent();
      await expect(service.cancelByCustomer(customer, 'c-1')).rejects.toThrow(
        /scheduled start time/,
      );
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('payment visibility in cancellation responses', () => {
    const withPayment = () => ({
      ...base,
      payments: [
        {
          id: 'pay-1',
          status: 'PAID',
          provider: 'MOCK',
          amount: '1500.00',
          currency: 'LKR',
          paidAt: new Date(),
          attempts: [
            {
              id: 'att-1',
              merchantReference: 'wp_secret_ref',
              status: 'PAID',
              provider: 'MOCK',
              createdAt: new Date(),
            },
          ],
        },
      ],
    });

    it("the astrologer's cancel response carries no payment or merchant reference", async () => {
      setCurrent();
      tx.appointment.findUniqueOrThrow.mockResolvedValue(withPayment());
      const view = await service.cancelByAstrologer(astrologer, 'c-1');
      expect(view.payment).toBeNull();
      expect(JSON.stringify(view)).not.toContain('wp_secret_ref');
    });

    it("the customer's own cancel response keeps their payment", async () => {
      setCurrent();
      tx.appointment.findUniqueOrThrow.mockResolvedValue(withPayment());
      const view = await service.cancelByCustomer(customer, 'c-1');
      expect(view.payment?.latestAttempt?.merchantReference).toBe(
        'wp_secret_ref',
      );
    });

    it('internal lifecycle results never include payment details', async () => {
      setCurrent();
      tx.appointment.findUniqueOrThrow.mockResolvedValue(withPayment());
      const view = await service.recordNoShow(
        capability(),
        {
          appointmentId: 'apt-1',
          customerJoined: false,
          astrologerJoined: true,
        },
        minutes(11),
      );
      expect(view.payment).toBeNull();
    });
  });

  describe('astrologer cancellation', () => {
    it('cancels with a full refund obligation and a CANCELLATION incident', async () => {
      setCurrent();
      await service.cancelByAstrologer(astrologer, 'c-1', 'ill');
      expect(updateData().data).toMatchObject({
        status: AppointmentStatus.CANCELLED_BY_ASTROLOGER,
        refundObligation: 'FULL_REFUND_DUE',
      });
      expectConsultationClosed();
      expect(tx.astrologerReliabilityIncident.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            appointmentId_type: {
              appointmentId: 'apt-1',
              type: 'CANCELLATION',
            },
          },
          create: expect.objectContaining({ astrologerId: 'ap-1' }) as unknown,
        }),
      );
    });

    it('is idempotent on repeat and records no second incident', async () => {
      setCurrent({ status: AppointmentStatus.CANCELLED_BY_ASTROLOGER });
      await service.cancelByAstrologer(astrologer, 'c-1');
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
      expect(tx.astrologerReliabilityIncident.upsert).not.toHaveBeenCalled();
    });

    it('rejects an astrologer who does not own the appointment', async () => {
      setCurrent();
      prisma.astrologerProfile.findUnique.mockResolvedValue({ id: 'ap-OTHER' });
      await expect(
        service.cancelByAstrologer(astrologer, 'c-1'),
      ).rejects.toThrow(NotFoundException);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects customers', async () => {
      await expect(service.cancelByAstrologer(customer, 'c-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects cancel once the session is in progress', async () => {
      setCurrent({ status: AppointmentStatus.IN_PROGRESS });
      await expect(
        service.cancelByAstrologer(astrologer, 'c-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('verified session start', () => {
    const event = (at: Date, eventId = 'evt-start') => ({
      eventId,
      appointmentId: 'apt-1',
      occurredAt: at,
    });

    it('moves CONFIRMED → IN_PROGRESS inside the join window', async () => {
      setCurrent();
      await service.recordSessionStart(capability(), event(minutes(-10)));
      expect(updateData().where).toEqual({ id: 'apt-1', status: 'CONFIRMED' });
      expect(updateData().data).toMatchObject({
        status: AppointmentStatus.IN_PROGRESS,
        sessionStartedAt: minutes(-10),
        sessionStartEventId: 'evt-start',
      });
    });

    it.each([-11, 11])(
      'rejects a start %i minutes from schedule',
      async (m) => {
        setCurrent();
        await expect(
          service.recordSessionStart(capability(), event(minutes(m))),
        ).rejects.toThrow(BadRequestException);
        expect(tx.appointment.updateMany).not.toHaveBeenCalled();
      },
    );

    it('is idempotent for the same event and rejects a different one', async () => {
      setCurrent({
        status: AppointmentStatus.IN_PROGRESS,
        sessionStartEventId: 'evt-start',
        sessionStartedAt: minutes(0),
      });
      await service.recordSessionStart(capability(), event(minutes(0)));
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
      await expect(
        service.recordSessionStart(
          capability(),
          event(minutes(0), 'evt-other'),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it.each([
      AppointmentStatus.PAYMENT_PENDING,
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
      AppointmentStatus.NO_SHOW_BOTH,
      AppointmentStatus.COMPLETED,
    ])('rejects start from %s', async (status) => {
      setCurrent({ status });
      await expect(
        service.recordSessionStart(capability(), event(minutes(0))),
      ).rejects.toThrow(ConflictException);
    });

    it('maps a reused provider event id (unique violation) to a conflict', async () => {
      setCurrent();
      tx.appointment.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.recordSessionStart(capability(), event(minutes(0))),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('verified session end', () => {
    const end = (at: Date, eventId = 'evt-end') => ({
      eventId,
      appointmentId: 'apt-1',
      occurredAt: at,
    });
    const inProgress = {
      status: AppointmentStatus.IN_PROGRESS,
      sessionStartedAt: minutes(0),
      sessionStartEventId: 'evt-start',
    };

    it('completes, deriving the duration from verified timestamps and stamping the consultation', async () => {
      setCurrent(inProgress);
      await service.recordSessionEnd(capability(), end(minutes(12.5)));
      expect(updateData().where).toEqual({
        id: 'apt-1',
        status: 'IN_PROGRESS',
      });
      expect(updateData().data).toMatchObject({
        status: AppointmentStatus.COMPLETED,
        sessionEndedAt: minutes(12.5),
        actualDurationSeconds: 750,
        sessionEndEventId: 'evt-end',
      });
      expect(tx.consultation.updateMany).toHaveBeenCalledWith({
        where: { id: 'c-1', status: 'ACCEPTED' },
        data: { status: 'COMPLETED', completedAt: minutes(12.5) },
      });
    });

    it('allows a very short session (no minimum duration)', async () => {
      setCurrent(inProgress);
      await service.recordSessionEnd(capability(), end(minutes(0)));
      expect(updateData().data.actualDurationSeconds).toBe(0);
    });

    it('rejects an end before the start', async () => {
      setCurrent(inProgress);
      await expect(
        service.recordSessionEnd(capability(), end(minutes(-1))),
      ).rejects.toThrow(BadRequestException);
    });

    it('is idempotent for the same event and rejects a different one', async () => {
      setCurrent({
        ...inProgress,
        status: AppointmentStatus.COMPLETED,
        sessionEndEventId: 'evt-end',
      });
      await service.recordSessionEnd(capability(), end(minutes(30)));
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
      expect(tx.consultation.updateMany).not.toHaveBeenCalled();
      await expect(
        service.recordSessionEnd(capability(), end(minutes(31), 'evt-other')),
      ).rejects.toThrow(ConflictException);
    });

    it.each([
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      AppointmentStatus.NO_SHOW_CUSTOMER,
    ])('cannot complete from %s', async (status) => {
      setCurrent({ status });
      await expect(
        service.recordSessionEnd(capability(), end(minutes(30))),
      ).rejects.toThrow(ConflictException);
    });

    it('a concurrent completion cannot double-apply', async () => {
      setCurrent(inProgress);
      tx.appointment.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.recordSessionEnd(capability(), end(minutes(30))),
      ).rejects.toThrow(ConflictException);
      expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('verified no-show', () => {
    const report = (customerJoined: boolean, astrologerJoined: boolean) => ({
      appointmentId: 'apt-1',
      customerJoined,
      astrologerJoined,
    });
    const afterGrace = minutes(10.5);

    it('customer no-show: manual review, no refund obligation, no incident', async () => {
      setCurrent();
      await service.recordNoShow(capability(), report(false, true), afterGrace);
      expect(updateData().data).toMatchObject({
        status: AppointmentStatus.NO_SHOW_CUSTOMER,
        manualReviewRequired: true,
        noShowRecordedAt: afterGrace,
      });
      expect(updateData().data.refundObligation).toBeUndefined();
      expectConsultationClosed();
      expect(tx.astrologerReliabilityIncident.upsert).not.toHaveBeenCalled();
    });

    it('astrologer no-show: full refund obligation and a NO_SHOW incident', async () => {
      setCurrent();
      await service.recordNoShow(capability(), report(true, false), afterGrace);
      expect(updateData().data).toMatchObject({
        status: AppointmentStatus.NO_SHOW_ASTROLOGER,
        refundObligation: 'FULL_REFUND_DUE',
        manualReviewRequired: false,
      });
      expectConsultationClosed();
      expect(tx.astrologerReliabilityIncident.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            appointmentId_type: { appointmentId: 'apt-1', type: 'NO_SHOW' },
          },
        }),
      );
    });

    it('both absent: full refund obligation, no review, no earnings path', async () => {
      setCurrent();
      await service.recordNoShow(
        capability(),
        report(false, false),
        afterGrace,
      );
      expect(updateData().data).toMatchObject({
        status: AppointmentStatus.NO_SHOW_BOTH,
        refundObligation: 'FULL_REFUND_DUE',
        manualReviewRequired: false,
      });
      // Closed (CANCELLED) but never completed: no completedAt.
      expectConsultationClosed();
    });

    it('refuses to classify before the grace period has elapsed', async () => {
      setCurrent();
      await expect(
        service.recordNoShow(capability(), report(false, false), minutes(10)),
      ).rejects.toThrow(ConflictException);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an attendance report where both joined', async () => {
      await expect(
        service.recordNoShow(capability(), report(true, true), afterGrace),
      ).rejects.toThrow(BadRequestException);
    });

    it('is idempotent for the same outcome and conflicts on a different one', async () => {
      setCurrent({ status: AppointmentStatus.NO_SHOW_ASTROLOGER });
      await service.recordNoShow(capability(), report(true, false), afterGrace);
      expect(tx.appointment.updateMany).not.toHaveBeenCalled();
      await expect(
        service.recordNoShow(capability(), report(false, false), afterGrace),
      ).rejects.toThrow(ConflictException);
    });

    it('cannot mark a started or cancelled appointment as a no-show', async () => {
      for (const status of [
        AppointmentStatus.IN_PROGRESS,
        AppointmentStatus.CANCELLED_BY_CUSTOMER,
        AppointmentStatus.COMPLETED,
      ]) {
        setCurrent({ status });
        await expect(
          service.recordNoShow(capability(), report(false, true), afterGrace),
        ).rejects.toThrow(ConflictException);
      }
    });
  });

  describe('consultation closure atomicity', () => {
    it('aborts every transition when the consultation is not ACCEPTED (nothing is silently overwritten)', async () => {
      const mismatch = () =>
        tx.consultation.updateMany.mockResolvedValue({ count: 0 });

      setCurrent();
      mismatch();
      await expect(service.cancelByCustomer(customer, 'c-1')).rejects.toThrow(
        /not in the expected ACCEPTED state/,
      );
      mismatch();
      await expect(
        service.cancelByAstrologer(astrologer, 'c-1'),
      ).rejects.toThrow(ConflictException);
      mismatch();
      await expect(
        service.recordNoShow(
          capability(),
          {
            appointmentId: 'apt-1',
            customerJoined: false,
            astrologerJoined: false,
          },
          minutes(11),
        ),
      ).rejects.toThrow(ConflictException);

      setCurrent({
        status: AppointmentStatus.IN_PROGRESS,
        sessionStartedAt: minutes(0),
      });
      mismatch();
      await expect(
        service.recordSessionEnd(capability(), {
          eventId: 'evt-end',
          appointmentId: 'apt-1',
          occurredAt: minutes(5),
        }),
      ).rejects.toThrow(ConflictException);
      // The consultation update is the last write that can fail: it throws
      // inside the lock transaction, so the surrounding transaction rolls back
      // (verified against a real database in the E2E suite).
    });

    it('closes the consultation only after the guarded appointment update succeeded', async () => {
      setCurrent();
      tx.appointment.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancelByCustomer(customer, 'c-1')).rejects.toThrow(
        ConflictException,
      );
      expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    });

    it('repeated terminal events do not touch the consultation again', async () => {
      setCurrent({ status: AppointmentStatus.CANCELLED_BY_CUSTOMER });
      await service.cancelByCustomer(customer, 'c-1');
      setCurrent({
        status: AppointmentStatus.NO_SHOW_ASTROLOGER,
      });
      await service.recordNoShow(
        capability(),
        {
          appointmentId: 'apt-1',
          customerJoined: true,
          astrologerJoined: false,
        },
        minutes(11),
      );
      expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    });
  });

  it('no lifecycle path creates payment, ledger or referral records', () => {
    // The mocked tx exposes only appointment/consultation/incident delegates;
    // any other model access would throw. Guard against accidental coupling.
    expect(Object.keys(tx).sort()).toEqual([
      'appointment',
      'astrologerReliabilityIncident',
      'consultation',
    ]);
  });
});

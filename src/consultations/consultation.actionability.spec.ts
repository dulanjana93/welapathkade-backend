import { AppointmentStatus, ConsultationStatus } from '@prisma/client';
import {
  deriveConsultationActionability,
  type ConsultationStage,
} from './consultation.actionability';

type Input = Parameters<typeof deriveConsultationActionability>[0];

const base: Input = {
  viewer: 'CUSTOMER',
  consultationStatus: ConsultationStatus.ACCEPTED,
  hasPendingProposal: false,
  hasAcceptedProposal: false,
  appointmentStatus: null,
};
const derive = (overrides: Partial<Input>) =>
  deriveConsultationActionability({ ...base, ...overrides });

describe('deriveConsultationActionability', () => {
  it.each<[string, Partial<Input>, ConsultationStage]>([
    [
      'pending request',
      { consultationStatus: ConsultationStatus.PENDING },
      'REQUEST_PENDING',
    ],
    ['accepted, awaiting a proposal', {}, 'AWAITING_PROPOSAL'],
    [
      'proposal awaiting the customer',
      { hasPendingProposal: true },
      'PROPOSAL_AWAITING_CUSTOMER',
    ],
    [
      'accepted proposal, no appointment yet',
      { hasAcceptedProposal: true },
      'AWAITING_PAYMENT',
    ],
    [
      'payment pending',
      {
        hasAcceptedProposal: true,
        appointmentStatus: AppointmentStatus.PAYMENT_PENDING,
      },
      'AWAITING_PAYMENT',
    ],
    [
      'payment hold expired (re-checkout allowed)',
      {
        hasAcceptedProposal: true,
        appointmentStatus: AppointmentStatus.PAYMENT_EXPIRED,
      },
      'AWAITING_PAYMENT',
    ],
    [
      'confirmed',
      { appointmentStatus: AppointmentStatus.CONFIRMED },
      'CONFIRMED',
    ],
    [
      'in progress',
      { appointmentStatus: AppointmentStatus.IN_PROGRESS },
      'IN_PROGRESS',
    ],
    [
      'completed',
      {
        consultationStatus: ConsultationStatus.COMPLETED,
        appointmentStatus: AppointmentStatus.COMPLETED,
        completedAt: new Date('2026-10-17T12:00:00.000Z'),
      },
      'COMPLETED',
    ],
    [
      'cancelled by customer',
      {
        consultationStatus: ConsultationStatus.CANCELLED,
        appointmentStatus: AppointmentStatus.CANCELLED_BY_CUSTOMER,
      },
      'CANCELLED_BY_CUSTOMER',
    ],
    [
      'cancelled by astrologer',
      {
        consultationStatus: ConsultationStatus.CANCELLED,
        appointmentStatus: AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      },
      'CANCELLED_BY_ASTROLOGER',
    ],
    [
      'customer no-show',
      {
        consultationStatus: ConsultationStatus.CANCELLED,
        appointmentStatus: AppointmentStatus.NO_SHOW_CUSTOMER,
      },
      'NO_SHOW_CUSTOMER',
    ],
    [
      'astrologer no-show',
      {
        consultationStatus: ConsultationStatus.CANCELLED,
        appointmentStatus: AppointmentStatus.NO_SHOW_ASTROLOGER,
      },
      'NO_SHOW_ASTROLOGER',
    ],
    [
      'both absent',
      {
        consultationStatus: ConsultationStatus.CANCELLED,
        appointmentStatus: AppointmentStatus.NO_SHOW_BOTH,
      },
      'NO_SHOW_BOTH',
    ],
    [
      'declined request',
      { consultationStatus: ConsultationStatus.DECLINED },
      'REQUEST_DECLINED',
    ],
    [
      'expired request',
      { consultationStatus: ConsultationStatus.EXPIRED },
      'REQUEST_EXPIRED',
    ],
    [
      'cancelled request (no appointment)',
      { consultationStatus: ConsultationStatus.CANCELLED },
      'REQUEST_CANCELLED',
    ],
  ])('%s', (_name, overrides, stage) => {
    expect(derive(overrides).stage).toBe(stage);
  });

  it('only AWAITING_PAYMENT allows checkout, and only for the customer', () => {
    const payable = derive({ hasAcceptedProposal: true });
    expect(payable.canCheckout).toBe(true);
    expect(
      derive({ hasAcceptedProposal: true, viewer: 'ASTROLOGER' }).canCheckout,
    ).toBe(false);

    for (const appointmentStatus of [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.CANCELLED_BY_CUSTOMER,
      AppointmentStatus.CANCELLED_BY_ASTROLOGER,
      AppointmentStatus.NO_SHOW_CUSTOMER,
      AppointmentStatus.NO_SHOW_ASTROLOGER,
      AppointmentStatus.NO_SHOW_BOTH,
    ]) {
      expect(
        derive({ hasAcceptedProposal: true, appointmentStatus }).canCheckout,
      ).toBe(false);
    }
  });

  it('a terminal appointment is never checkout-eligible even if the consultation is still ACCEPTED (legacy rows)', () => {
    const view = derive({
      consultationStatus: ConsultationStatus.ACCEPTED,
      hasAcceptedProposal: true,
      appointmentStatus: AppointmentStatus.CANCELLED_BY_CUSTOMER,
    });
    expect(view.stage).toBe('CANCELLED_BY_CUSTOMER');
    expect(view.canCheckout).toBe(false);
    expect(view.isClosed).toBe(true);
  });

  it('role-specific actions', () => {
    const pending = { consultationStatus: ConsultationStatus.PENDING };
    expect(derive(pending).canCancelRequest).toBe(true);
    expect(derive(pending).canRespondToRequest).toBe(false);
    expect(
      derive({ ...pending, viewer: 'ASTROLOGER' }).canRespondToRequest,
    ).toBe(true);
    expect(derive({ viewer: 'ASTROLOGER' }).canPropose).toBe(true);
    expect(derive({}).canPropose).toBe(false);
    expect(derive({ hasPendingProposal: true }).canRespondToProposal).toBe(
      true,
    );
    const future = new Date(Date.now() + 3_600_000);
    expect(
      derive({
        appointmentStatus: AppointmentStatus.CONFIRMED,
        appointmentStartAt: future,
      }).canCancelAppointment,
    ).toBe(true);
    expect(
      derive({
        viewer: 'ASTROLOGER',
        appointmentStatus: AppointmentStatus.CONFIRMED,
        appointmentStartAt: future,
      }).canCancelAppointment,
    ).toBe(true);
    expect(
      derive({ appointmentStatus: AppointmentStatus.IN_PROGRESS })
        .canCancelAppointment,
    ).toBe(false);
  });

  describe('canCancelAppointment follows the cancellation time rule', () => {
    const start = new Date('2026-10-01T04:30:00.000Z');
    const confirmed = (nowMs: number, viewer: 'CUSTOMER' | 'ASTROLOGER') =>
      derive({
        viewer,
        appointmentStatus: AppointmentStatus.CONFIRMED,
        appointmentStartAt: start,
        now: new Date(start.getTime() + nowMs),
      });

    it.each(['CUSTOMER', 'ASTROLOGER'] as const)(
      '%s: allowed only strictly before the scheduled start',
      (viewer) => {
        expect(confirmed(-24 * 3_600_000, viewer).canCancelAppointment).toBe(
          true,
        );
        expect(confirmed(-600_000, viewer).canCancelAppointment).toBe(true);
        expect(confirmed(-1, viewer).canCancelAppointment).toBe(true);
        expect(confirmed(0, viewer).canCancelAppointment).toBe(false);
        expect(confirmed(1, viewer).canCancelAppointment).toBe(false);
        expect(confirmed(600_000, viewer).canCancelAppointment).toBe(false);
        expect(confirmed(600_001, viewer).canCancelAppointment).toBe(false);
      },
    );

    it('keeps the CONFIRMED stage after the start; only the permission changes', () => {
      const late = confirmed(5 * 60_000, 'CUSTOMER');
      expect(late.stage).toBe('CONFIRMED');
      expect(late.isClosed).toBe(false);
      expect(late.canCancelAppointment).toBe(false);
    });

    it('fails closed when the appointment start time is unknown', () => {
      expect(
        derive({ appointmentStatus: AppointmentStatus.CONFIRMED })
          .canCancelAppointment,
      ).toBe(false);
    });
  });

  it('closed vs open', () => {
    expect(derive({}).isClosed).toBe(false);
    expect(
      derive({ appointmentStatus: AppointmentStatus.CONFIRMED }).isClosed,
    ).toBe(false);
    expect(
      derive({ appointmentStatus: AppointmentStatus.IN_PROGRESS }).isClosed,
    ).toBe(false);
    expect(
      derive({ appointmentStatus: AppointmentStatus.COMPLETED }).isClosed,
    ).toBe(true);
  });

  it('post-consultation actions only after COMPLETED', () => {
    const completedAt = new Date('2026-10-17T12:00:00.000Z');
    const now = new Date('2026-10-18T00:00:00.000Z');
    const customerDone = derive({
      appointmentStatus: AppointmentStatus.COMPLETED,
      completedAt,
      customerMessagesRemaining: 3,
      now,
    });
    expect(customerDone.canBookAgain).toBe(true);
    expect(customerDone.canWriteSummary).toBe(false);
    expect(customerDone.canSendFollowUpMessage).toBe(true);

    const astroDone = derive({
      viewer: 'ASTROLOGER',
      appointmentStatus: AppointmentStatus.COMPLETED,
      completedAt,
      customerMessagesRemaining: 0,
      now,
    });
    expect(astroDone.canWriteSummary).toBe(true);
    expect(astroDone.canBookAgain).toBe(false);
    expect(astroDone.canSendFollowUpMessage).toBe(true);

    expect(
      derive({
        appointmentStatus: AppointmentStatus.CONFIRMED,
        completedAt: null,
      }).canBookAgain,
    ).toBe(false);
  });

  describe('canJoinVideoSession follows the video credential window', () => {
    const start = new Date('2026-10-01T04:30:00.000Z');
    const end = new Date('2026-10-01T05:00:00.000Z');
    const joinable = (
      status: AppointmentStatus,
      nowMs: number,
      viewer: 'CUSTOMER' | 'ASTROLOGER' = 'CUSTOMER',
    ) =>
      derive({
        viewer,
        appointmentStatus: status,
        appointmentStartAt: start,
        appointmentEndAt: end,
        now: new Date(start.getTime() + nowMs),
      }).canJoinVideoSession;

    it('CONFIRMED: only inside [start-10m, start+10m]', () => {
      expect(joinable(AppointmentStatus.CONFIRMED, -11 * 60_000)).toBe(false);
      expect(joinable(AppointmentStatus.CONFIRMED, -10 * 60_000)).toBe(true);
      expect(joinable(AppointmentStatus.CONFIRMED, 0)).toBe(true);
      expect(joinable(AppointmentStatus.CONFIRMED, 10 * 60_000)).toBe(true);
      expect(joinable(AppointmentStatus.CONFIRMED, 10 * 60_000 + 1)).toBe(
        false,
      );
    });

    it('IN_PROGRESS: allowed through endAt + buffer for both roles', () => {
      expect(joinable(AppointmentStatus.IN_PROGRESS, 20 * 60_000)).toBe(true);
      expect(
        joinable(AppointmentStatus.IN_PROGRESS, 20 * 60_000, 'ASTROLOGER'),
      ).toBe(true);
      expect(joinable(AppointmentStatus.IN_PROGRESS, 35 * 60_000 + 1)).toBe(
        false,
      );
    });

    it('fails closed for terminal statuses or missing times', () => {
      expect(joinable(AppointmentStatus.COMPLETED, 0)).toBe(false);
      expect(
        derive({
          appointmentStatus: AppointmentStatus.CONFIRMED,
          appointmentStartAt: start,
        }).canJoinVideoSession,
      ).toBe(false);
    });
  });
});

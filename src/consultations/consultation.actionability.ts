import { AppointmentStatus, ConsultationStatus } from '@prisma/client';
import { isCancellationAllowedAt } from '../payments/appointment.state';
import {
  isVideoJoinableStatus,
  isWithinVideoCredentialWindow,
} from '../video/video-session.eligibility';
import { FOLLOW_UP_WINDOW_HOURS } from './consultation-follow-up.constants';

/**
 * Server-derived stage and allowed actions for a consultation detail.
 *
 * Derived only from authoritative state (consultation status, proposals and the
 * linked appointment), so clients never have to infer "can I pay?" from
 * `status === ACCEPTED`. The appointment status stays the source of truth for
 * the exact outcome (who cancelled, which participant was absent).
 */
export type ConsultationStage =
  | 'REQUEST_PENDING'
  | 'REQUEST_DECLINED'
  | 'REQUEST_EXPIRED'
  | 'REQUEST_CANCELLED'
  | 'AWAITING_PROPOSAL'
  | 'PROPOSAL_AWAITING_CUSTOMER'
  | 'AWAITING_PAYMENT'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED_BY_CUSTOMER'
  | 'CANCELLED_BY_ASTROLOGER'
  | 'NO_SHOW_CUSTOMER'
  | 'NO_SHOW_ASTROLOGER'
  | 'NO_SHOW_BOTH';

export type ConsultationActionability = {
  stage: ConsultationStage;
  /** True when no further action will ever be possible. */
  isClosed: boolean;
  /** Customer: cancel the still-PENDING request. */
  canCancelRequest: boolean;
  /** Astrologer: accept or decline the PENDING request. */
  canRespondToRequest: boolean;
  /** Astrologer: create an appointment proposal. */
  canPropose: boolean;
  /** Customer: accept or reject the pending proposal. */
  canRespondToProposal: boolean;
  /** Customer: Confirm & Pay is available. Never true for a terminal appointment. */
  canCheckout: boolean;
  /** Either participant: cancel the CONFIRMED appointment. */
  canCancelAppointment: boolean;
  /**
   * Either participant: obtain Agora RTC credentials / join the video call.
   * True only inside the server join / in-progress credential window.
   */
  canJoinVideoSession: boolean;
  /** Astrologer: write or update the optional post-session summary. */
  canWriteSummary: boolean;
  /**
   * Either participant: send a follow-up text message.
   * Exact remaining-limit / window checks are enforced on the message write path.
   */
  canSendFollowUpMessage: boolean;
  /** Customer: start a new request from this completed consultation (Book Again). */
  canBookAgain: boolean;
  /** Customer: submit a first review for an eligible completed consultation. */
  canSubmitReview: boolean;
  /** Customer: edit their existing review while the consultation remains eligible. */
  canEditReview: boolean;
};

export type ActionabilityViewer = 'CUSTOMER' | 'ASTROLOGER';

const CLOSED_STAGES: ReadonlySet<ConsultationStage> = new Set([
  'REQUEST_DECLINED',
  'REQUEST_EXPIRED',
  'REQUEST_CANCELLED',
  'COMPLETED',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_ASTROLOGER',
  'NO_SHOW_CUSTOMER',
  'NO_SHOW_ASTROLOGER',
  'NO_SHOW_BOTH',
]);

function stageFromAppointment(
  status: AppointmentStatus,
): ConsultationStage | null {
  switch (status) {
    case AppointmentStatus.CONFIRMED:
      return 'CONFIRMED';
    case AppointmentStatus.IN_PROGRESS:
      return 'IN_PROGRESS';
    case AppointmentStatus.COMPLETED:
      return 'COMPLETED';
    case AppointmentStatus.CANCELLED_BY_CUSTOMER:
      return 'CANCELLED_BY_CUSTOMER';
    case AppointmentStatus.CANCELLED_BY_ASTROLOGER:
      return 'CANCELLED_BY_ASTROLOGER';
    case AppointmentStatus.NO_SHOW_CUSTOMER:
      return 'NO_SHOW_CUSTOMER';
    case AppointmentStatus.NO_SHOW_ASTROLOGER:
      return 'NO_SHOW_ASTROLOGER';
    case AppointmentStatus.NO_SHOW_BOTH:
      return 'NO_SHOW_BOTH';
    case AppointmentStatus.CANCELLED:
      return 'REQUEST_CANCELLED'; // legacy value, never written
    default:
      // PAYMENT_PENDING / PAYMENT_EXPIRED: decided by the consultation below.
      return null;
  }
}

export function deriveConsultationActionability(input: {
  viewer: ActionabilityViewer;
  consultationStatus: ConsultationStatus;
  hasPendingProposal: boolean;
  hasAcceptedProposal: boolean;
  appointmentStatus: AppointmentStatus | null;
  /** Scheduled start of the linked appointment; needed for cancellation. */
  appointmentStartAt?: Date | null;
  /** Scheduled end; needed for video join eligibility. */
  appointmentEndAt?: Date | null;
  /**
   * Start of the accepted proposal. Checkout is refused for a slot that has
   * already started, so it must not be offered once that time has passed.
   */
  acceptedProposalStartAt?: Date | null;
  /**
   * Authoritative consultation completion time. Required to open the
   * post-session messaging window; missing values fail closed.
   */
  completedAt?: Date | null;
  /**
   * Remaining customer message allowance for follow-up. When omitted, the
   * messaging flag only reflects stage/window (exact limit enforced on write).
   */
  customerMessagesRemaining?: number | null;
  /**
   * Review flags for the customer detail. When omitted, both stay false
   * (list rows and astrologer viewers never offer review mutations).
   */
  canSubmitReview?: boolean;
  canEditReview?: boolean;
  /** Injectable clock for tests. */
  now?: Date;
}): ConsultationActionability {
  const fromAppointment = input.appointmentStatus
    ? stageFromAppointment(input.appointmentStatus)
    : null;

  let stage: ConsultationStage;
  if (fromAppointment) {
    // The appointment outcome is authoritative, even for rows whose
    // consultation was not closed (e.g. written before consultation closure).
    stage = fromAppointment;
  } else {
    switch (input.consultationStatus) {
      case ConsultationStatus.PENDING:
        stage = 'REQUEST_PENDING';
        break;
      case ConsultationStatus.DECLINED:
        stage = 'REQUEST_DECLINED';
        break;
      case ConsultationStatus.EXPIRED:
        stage = 'REQUEST_EXPIRED';
        break;
      case ConsultationStatus.CANCELLED:
        stage = 'REQUEST_CANCELLED';
        break;
      case ConsultationStatus.COMPLETED:
        stage = 'COMPLETED';
        break;
      default:
        stage = input.hasPendingProposal
          ? 'PROPOSAL_AWAITING_CUSTOMER'
          : input.hasAcceptedProposal
            ? 'AWAITING_PAYMENT'
            : 'AWAITING_PROPOSAL';
    }
  }

  const customer = input.viewer === 'CUSTOMER';
  const accepted = input.consultationStatus === ConsultationStatus.ACCEPTED;
  const now = input.now ?? new Date();
  const appointmentStatus = input.appointmentStatus;
  const canJoinVideoSession =
    !!appointmentStatus &&
    !!input.appointmentStartAt &&
    !!input.appointmentEndAt &&
    isVideoJoinableStatus(appointmentStatus) &&
    isWithinVideoCredentialWindow({
      status: appointmentStatus,
      startAt: input.appointmentStartAt,
      endAt: input.appointmentEndAt,
      now,
    });
  const completedSuccessfully = stage === 'COMPLETED';
  const followUpOpen =
    completedSuccessfully &&
    !!input.completedAt &&
    now.getTime() <
      input.completedAt.getTime() + FOLLOW_UP_WINDOW_HOURS * 60 * 60 * 1000;
  const customerRemaining =
    input.customerMessagesRemaining == null
      ? null
      : Math.max(0, input.customerMessagesRemaining);
  const canSendFollowUpMessage =
    followUpOpen &&
    (customer ? customerRemaining == null || customerRemaining > 0 : true);

  return {
    stage,
    isClosed: CLOSED_STAGES.has(stage),
    canCancelRequest: customer && stage === 'REQUEST_PENDING',
    canRespondToRequest: !customer && stage === 'REQUEST_PENDING',
    canPropose: !customer && stage === 'AWAITING_PROPOSAL',
    canRespondToProposal: customer && stage === 'PROPOSAL_AWAITING_CUSTOMER',
    canCheckout:
      customer &&
      accepted &&
      stage === 'AWAITING_PAYMENT' &&
      !(
        input.acceptedProposalStartAt &&
        input.acceptedProposalStartAt.getTime() <= now.getTime()
      ),
    // Mirrors the cancellation rule: only strictly before the scheduled start.
    // A missing start time fails closed.
    canCancelAppointment:
      stage === 'CONFIRMED' &&
      !!input.appointmentStartAt &&
      isCancellationAllowedAt(input.appointmentStartAt, now),
    canJoinVideoSession,
    canWriteSummary: !customer && completedSuccessfully,
    canSendFollowUpMessage,
    canBookAgain: customer && completedSuccessfully,
    canSubmitReview: customer && !!input.canSubmitReview,
    canEditReview: customer && !!input.canEditReview,
  };
}

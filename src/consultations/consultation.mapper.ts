import {
  Consultation,
  ConsultationFile,
  ConsultationFileType,
  AppointmentStatus,
  ConsultationStatus,
  File,
  FileStatus,
  type AstrologerProfile,
  type User,
} from '@prisma/client';
import { toMoneyString, type MoneyString } from '../common/money/money';
import { BUSINESS_TIMEZONE } from '../availability/availability.constants';
import { DateTime } from 'luxon';
import type { AppointmentView } from '../payments/appointment.mapper';
import {
  deriveConsultationActionability,
  type ConsultationActionability,
} from './consultation.actionability';
import type { FollowUpMessagingView } from './consultation-follow-up';
import type { OwnReviewView } from './consultation-reviews.service';
import type { ProposalView } from './proposal.mapper';

export type ConsultationFileMetaView = {
  id: string;
  type: ConsultationFileType;
  sortOrder: number;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
  createdAt: Date;
};

type FileJoin = ConsultationFile & { file: File };

function toFileMeta(row: FileJoin) {
  return {
    id: row.id,
    type: row.type,
    sortOrder: row.sortOrder,
    originalFilename: row.file.originalFilename,
    mimeType: row.file.mimeType,
    sizeBytes: row.file.sizeBytes,
    status: row.file.status,
    createdAt: row.createdAt,
  };
}

function preferredLocal(startAt: Date, endAt?: Date | null) {
  const local = DateTime.fromJSDate(startAt, { zone: 'utc' }).setZone(
    BUSINESS_TIMEZONE,
  );
  const localEnd = endAt
    ? DateTime.fromJSDate(endAt, { zone: 'utc' }).setZone(BUSINESS_TIMEZONE)
    : null;
  return {
    preferredStartAt: startAt.toISOString(),
    preferredEndAt: endAt ? endAt.toISOString() : null,
    preferredLocalDate: local.toISODate(),
    preferredLocalStartTime: local.toFormat('HH:mm'),
    preferredLocalEndTime: localEnd?.isValid
      ? localEnd.toFormat('HH:mm')
      : null,
    timezone: BUSINESS_TIMEZONE,
  };
}

export type ConsultationListItemView = {
  id: string;
  status: ConsultationStatus;
  message: string | null;
  requestedPrice: MoneyString;
  serviceNameSi: string;
  serviceNameEn: string;
  serviceId: string;
  preferredStartAt: string;
  preferredEndAt: string | null;
  preferredLocalDate: string | null;
  preferredLocalStartTime: string;
  preferredLocalEndTime: string | null;
  timezone: string;
  submittedAt: string;
  viewedAt: string | null;
  respondedAt: string | null;
  expiresAt: string;
  /** Authoritative completion time (UTC ISO), when the consultation completed. */
  completedAt: string | null;
  customer?: { id: string; name: string };
  astrologer?: { id: string; displayName: string };
};

export type ConsultationDetailView = ConsultationListItemView & {
  declineReason: string | null;
  files: ReturnType<typeof toFileMeta>[];
  astrologerServiceId: string;
  /** Proposal history newest-first (Phase 5A). Empty until proposals exist. */
  proposals: ProposalView[];
  pendingProposal: ProposalView | null;
  acceptedProposal: ProposalView | null;
  appointment: AppointmentView | null;
  /** Optional astrologer post-session note. */
  astrologerSummary: string | null;
  astrologerSummaryUpdatedAt: string | null;
  /** Post-session messaging window + customer allowance. */
  followUp: FollowUpMessagingView | null;
  /** Customer's review for this consultation, when present (customer detail only). */
  myReview: OwnReviewView | null;
  /** Server-derived stage and allowed actions; prefer this over inferring from `status`. */
  actionability: ConsultationActionability;
};

type ConsultationWithRelations = Consultation & {
  customer?: Pick<User, 'id' | 'name'>;
  astrologer?: Pick<AstrologerProfile, 'id' | 'displayName'>;
  files?: FileJoin[];
};

export function toCustomerListItem(
  c: ConsultationWithRelations,
): ConsultationListItemView {
  const local = preferredLocal(c.preferredStartAt, c.preferredEndAt);
  return {
    id: c.id,
    status: c.status,
    message: c.message,
    requestedPrice: toMoneyString(c.requestedPrice),
    serviceNameSi: c.serviceNameSi,
    serviceNameEn: c.serviceNameEn,
    serviceId: c.serviceId,
    preferredStartAt: local.preferredStartAt,
    preferredEndAt: local.preferredEndAt,
    preferredLocalDate: local.preferredLocalDate,
    preferredLocalStartTime: local.preferredLocalStartTime,
    preferredLocalEndTime: local.preferredLocalEndTime,
    timezone: local.timezone,
    submittedAt: c.submittedAt.toISOString(),
    viewedAt: c.viewedAt ? c.viewedAt.toISOString() : null,
    respondedAt: c.respondedAt ? c.respondedAt.toISOString() : null,
    expiresAt: c.expiresAt.toISOString(),
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    astrologer: c.astrologer
      ? { id: c.astrologer.id, displayName: c.astrologer.displayName }
      : undefined,
  };
}

export function toAstrologerListItem(
  c: ConsultationWithRelations,
): ConsultationListItemView {
  const base = toCustomerListItem(c);
  return {
    ...base,
    customer: c.customer
      ? { id: c.customer.id, name: c.customer.name }
      : undefined,
    astrologer: undefined,
  };
}

/**
 * Compact appointment facts for list rows. Deliberately excludes payment,
 * refund and session data so one shape is safe for both audiences.
 */
export type ListAppointmentSummaryView = {
  id: string;
  status: AppointmentView['status'];
  startAt: string;
  endAt: string;
  durationMinutes: number;
  /** Set only while the appointment is genuinely awaiting payment. */
  reservationExpiresAt: string | null;
  localDate: string | null;
  localStartTime: string;
  localEndTime: string;
  timezone: string;
};

/** List row with server-derived lifecycle (same rules as the detail view). */
export type ConsultationListEntryView = ConsultationListItemView & {
  actionability: ConsultationActionability;
  /** Pending proposal if any, otherwise the accepted one. */
  proposalSummary: ProposalView | null;
  appointmentSummary: ListAppointmentSummaryView | null;
};

export type ListLifecycleInput = {
  pendingProposal: ProposalView | null;
  acceptedProposal: ProposalView | null;
  appointment: AppointmentView | null;
};

export function toListAppointmentSummary(
  a: AppointmentView,
): ListAppointmentSummaryView {
  return {
    id: a.id,
    status: a.status,
    startAt: a.startAt,
    endAt: a.endAt,
    durationMinutes: a.durationMinutes,
    reservationExpiresAt:
      a.status === AppointmentStatus.PAYMENT_PENDING
        ? a.reservationExpiresAt
        : null,
    localDate: a.localDate,
    localStartTime: a.localStartTime,
    localEndTime: a.localEndTime,
    timezone: a.timezone,
  };
}

function withLifecycle(
  base: ConsultationListItemView,
  c: ConsultationWithRelations,
  viewer: 'CUSTOMER' | 'ASTROLOGER',
  lifecycle: ListLifecycleInput | undefined,
): ConsultationListEntryView {
  const appointment = lifecycle?.appointment ?? null;
  return {
    ...base,
    actionability: deriveConsultationActionability({
      viewer,
      consultationStatus: c.status,
      hasPendingProposal: !!lifecycle?.pendingProposal,
      hasAcceptedProposal: !!lifecycle?.acceptedProposal,
      appointmentStatus: appointment?.status ?? null,
      appointmentStartAt: appointment ? new Date(appointment.startAt) : null,
      appointmentEndAt: appointment ? new Date(appointment.endAt) : null,
      acceptedProposalStartAt: lifecycle?.acceptedProposal
        ? new Date(lifecycle.acceptedProposal.proposedStartAt)
        : null,
      completedAt: c.completedAt ?? null,
    }),
    proposalSummary:
      lifecycle?.pendingProposal ?? lifecycle?.acceptedProposal ?? null,
    appointmentSummary: appointment
      ? toListAppointmentSummary(appointment)
      : null,
  };
}

export function toCustomerListEntry(
  c: ConsultationWithRelations,
  lifecycle?: ListLifecycleInput,
): ConsultationListEntryView {
  return withLifecycle(toCustomerListItem(c), c, 'CUSTOMER', lifecycle);
}

export function toAstrologerListEntry(
  c: ConsultationWithRelations,
  lifecycle?: ListLifecycleInput,
): ConsultationListEntryView {
  return withLifecycle(toAstrologerListItem(c), c, 'ASTROLOGER', lifecycle);
}

export type DetailExtras = {
  followUp?: FollowUpMessagingView | null;
  customerMessagesRemaining?: number | null;
  myReview?: OwnReviewView | null;
  canSubmitReview?: boolean;
  canEditReview?: boolean;
};

export function toCustomerDetail(
  c: ConsultationWithRelations,
  proposalSummary?: {
    proposals: ProposalView[];
    pendingProposal: ProposalView | null;
    acceptedProposal: ProposalView | null;
  },
  appointment?: AppointmentView | null,
  extras?: DetailExtras,
): ConsultationDetailView {
  const followUp = extras?.followUp ?? null;
  return {
    ...toCustomerListItem(c),
    declineReason: c.declineReason,
    files: (c.files ?? []).map(toFileMeta),
    astrologerServiceId: c.astrologerServiceId,
    proposals: proposalSummary?.proposals ?? [],
    pendingProposal: proposalSummary?.pendingProposal ?? null,
    acceptedProposal: proposalSummary?.acceptedProposal ?? null,
    appointment: appointment ?? null,
    astrologerSummary: c.astrologerSummary ?? null,
    astrologerSummaryUpdatedAt: c.astrologerSummaryUpdatedAt
      ? c.astrologerSummaryUpdatedAt.toISOString()
      : null,
    followUp,
    myReview: extras?.myReview ?? null,
    actionability: deriveConsultationActionability({
      viewer: 'CUSTOMER',
      consultationStatus: c.status,
      hasPendingProposal: !!proposalSummary?.pendingProposal,
      hasAcceptedProposal: !!proposalSummary?.acceptedProposal,
      appointmentStatus: appointment?.status ?? null,
      appointmentStartAt: appointment ? new Date(appointment.startAt) : null,
      appointmentEndAt: appointment ? new Date(appointment.endAt) : null,
      acceptedProposalStartAt: proposalSummary?.acceptedProposal
        ? new Date(proposalSummary.acceptedProposal.proposedStartAt)
        : null,
      completedAt: c.completedAt ?? null,
      customerMessagesRemaining:
        extras?.customerMessagesRemaining ??
        followUp?.customerMessagesRemaining,
      canSubmitReview: extras?.canSubmitReview,
      canEditReview: extras?.canEditReview,
    }),
  };
}

export function toAstrologerDetail(
  c: ConsultationWithRelations,
  proposalSummary?: {
    proposals: ProposalView[];
    pendingProposal: ProposalView | null;
    acceptedProposal: ProposalView | null;
  },
  appointment?: AppointmentView | null,
  extras?: DetailExtras,
): ConsultationDetailView {
  const followUp = extras?.followUp ?? null;
  return {
    ...toAstrologerListItem(c),
    declineReason: c.declineReason,
    files: (c.files ?? []).map(toFileMeta),
    astrologerServiceId: c.astrologerServiceId,
    proposals: proposalSummary?.proposals ?? [],
    pendingProposal: proposalSummary?.pendingProposal ?? null,
    acceptedProposal: proposalSummary?.acceptedProposal ?? null,
    appointment: appointment ?? null,
    astrologerSummary: c.astrologerSummary ?? null,
    astrologerSummaryUpdatedAt: c.astrologerSummaryUpdatedAt
      ? c.astrologerSummaryUpdatedAt.toISOString()
      : null,
    followUp,
    myReview: null,
    actionability: deriveConsultationActionability({
      viewer: 'ASTROLOGER',
      consultationStatus: c.status,
      hasPendingProposal: !!proposalSummary?.pendingProposal,
      hasAcceptedProposal: !!proposalSummary?.acceptedProposal,
      appointmentStatus: appointment?.status ?? null,
      appointmentStartAt: appointment ? new Date(appointment.startAt) : null,
      appointmentEndAt: appointment ? new Date(appointment.endAt) : null,
      completedAt: c.completedAt ?? null,
      customerMessagesRemaining:
        extras?.customerMessagesRemaining ??
        followUp?.customerMessagesRemaining,
    }),
  };
}

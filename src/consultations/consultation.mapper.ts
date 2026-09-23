import {
  Consultation,
  ConsultationFile,
  ConsultationFileType,
  ConsultationStatus,
  File,
  FileStatus,
  type AstrologerProfile,
  type User,
} from '@prisma/client';
import { toMoneyString, type MoneyString } from '../common/money/money';
import { BUSINESS_TIMEZONE } from '../availability/availability.constants';
import { DateTime } from 'luxon';
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

function preferredLocal(startAt: Date) {
  const local = DateTime.fromJSDate(startAt, { zone: 'utc' }).setZone(
    BUSINESS_TIMEZONE,
  );
  return {
    preferredStartAt: startAt.toISOString(),
    preferredEndAt: null as string | null,
    preferredLocalDate: local.toISODate(),
    preferredLocalStartTime: local.toFormat('HH:mm'),
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
  timezone: string;
  submittedAt: string;
  viewedAt: string | null;
  respondedAt: string | null;
  expiresAt: string;
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
};

type ConsultationWithRelations = Consultation & {
  customer?: Pick<User, 'id' | 'name'>;
  astrologer?: Pick<AstrologerProfile, 'id' | 'displayName'>;
  files?: FileJoin[];
};

export function toCustomerListItem(
  c: ConsultationWithRelations,
): ConsultationListItemView {
  const local = preferredLocal(c.preferredStartAt);
  return {
    id: c.id,
    status: c.status,
    message: c.message,
    requestedPrice: toMoneyString(c.requestedPrice),
    serviceNameSi: c.serviceNameSi,
    serviceNameEn: c.serviceNameEn,
    serviceId: c.serviceId,
    preferredStartAt: local.preferredStartAt,
    preferredEndAt: c.preferredEndAt ? c.preferredEndAt.toISOString() : null,
    preferredLocalDate: local.preferredLocalDate,
    preferredLocalStartTime: local.preferredLocalStartTime,
    timezone: local.timezone,
    submittedAt: c.submittedAt.toISOString(),
    viewedAt: c.viewedAt ? c.viewedAt.toISOString() : null,
    respondedAt: c.respondedAt ? c.respondedAt.toISOString() : null,
    expiresAt: c.expiresAt.toISOString(),
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

export function toCustomerDetail(
  c: ConsultationWithRelations,
  proposalSummary?: {
    proposals: ProposalView[];
    pendingProposal: ProposalView | null;
    acceptedProposal: ProposalView | null;
  },
): ConsultationDetailView {
  return {
    ...toCustomerListItem(c),
    declineReason: c.declineReason,
    files: (c.files ?? []).map(toFileMeta),
    astrologerServiceId: c.astrologerServiceId,
    proposals: proposalSummary?.proposals ?? [],
    pendingProposal: proposalSummary?.pendingProposal ?? null,
    acceptedProposal: proposalSummary?.acceptedProposal ?? null,
  };
}

export function toAstrologerDetail(
  c: ConsultationWithRelations,
  proposalSummary?: {
    proposals: ProposalView[];
    pendingProposal: ProposalView | null;
    acceptedProposal: ProposalView | null;
  },
): ConsultationDetailView {
  return {
    ...toAstrologerListItem(c),
    declineReason: c.declineReason,
    files: (c.files ?? []).map(toFileMeta),
    astrologerServiceId: c.astrologerServiceId,
    proposals: proposalSummary?.proposals ?? [],
    pendingProposal: proposalSummary?.pendingProposal ?? null,
    acceptedProposal: proposalSummary?.acceptedProposal ?? null,
  };
}

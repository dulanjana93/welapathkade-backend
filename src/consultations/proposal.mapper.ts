import { ConsultationProposal, ProposalStatus } from '@prisma/client';
import { BUSINESS_TIMEZONE } from '../availability/availability.constants';
import { DateTime } from 'luxon';

export type ProposalView = {
  id: string;
  consultationId: string;
  proposedStartAt: string;
  proposedEndAt: string;
  durationMinutes: number;
  status: ProposalStatus;
  createdAt: string;
  respondedAt: string | null;
  localDate: string | null;
  localStartTime: string;
  localEndTime: string;
  timezone: string;
};

export function toProposalView(p: ConsultationProposal): ProposalView {
  const localStart = DateTime.fromJSDate(p.proposedStartAt, {
    zone: 'utc',
  }).setZone(BUSINESS_TIMEZONE);
  const localEnd = DateTime.fromJSDate(p.proposedEndAt, {
    zone: 'utc',
  }).setZone(BUSINESS_TIMEZONE);

  return {
    id: p.id,
    consultationId: p.consultationId,
    proposedStartAt: p.proposedStartAt.toISOString(),
    proposedEndAt: p.proposedEndAt.toISOString(),
    durationMinutes: p.durationMinutes,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    respondedAt: p.respondedAt ? p.respondedAt.toISOString() : null,
    localDate: localStart.toISODate(),
    localStartTime: localStart.toFormat('HH:mm'),
    localEndTime: localEnd.toFormat('HH:mm'),
    timezone: BUSINESS_TIMEZONE,
  };
}

export function summarizeProposals(proposals: ConsultationProposal[]) {
  const views = proposals.map(toProposalView);
  return {
    proposals: views,
    pendingProposal: views.find((p) => p.status === ProposalStatus.PENDING) ?? null,
    acceptedProposal:
      views.find((p) => p.status === ProposalStatus.ACCEPTED) ?? null,
  };
}

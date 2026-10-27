import { ProposalStatus } from '@prisma/client';

/**
 * Appointment proposal state machine (Phase 5A).
 *
 * PENDING
 *  ├── CUSTOMER_ACCEPT → ACCEPTED
 *  ├── CUSTOMER_REJECT → REJECTED
 *  └── SUPERSEDE       → SUPERSEDED  (when another proposal is accepted)
 *
 * Consultation.status ACCEPTED = astrologer accepted the request.
 * Proposal.status ACCEPTED = customer accepted a proposed time.
 * Neither means payment or a confirmed appointment (Phase 5B+).
 */
export const PROPOSAL_TERMINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  ProposalStatus.ACCEPTED,
  ProposalStatus.REJECTED,
  ProposalStatus.SUPERSEDED,
]);

export type ProposalTransition =
  'CUSTOMER_ACCEPT' | 'CUSTOMER_REJECT' | 'SUPERSEDE';

const ALLOWED: Record<
  ProposalTransition,
  { from: ProposalStatus; to: ProposalStatus }
> = {
  CUSTOMER_ACCEPT: {
    from: ProposalStatus.PENDING,
    to: ProposalStatus.ACCEPTED,
  },
  CUSTOMER_REJECT: {
    from: ProposalStatus.PENDING,
    to: ProposalStatus.REJECTED,
  },
  SUPERSEDE: {
    from: ProposalStatus.PENDING,
    to: ProposalStatus.SUPERSEDED,
  },
};

export function assertProposalTransition(
  current: ProposalStatus,
  transition: ProposalTransition,
): ProposalStatus {
  const rule = ALLOWED[transition];
  if (current !== rule.from) {
    throw new Error(
      `Invalid proposal transition ${transition} from ${current}`,
    );
  }
  return rule.to;
}

export function isProposalTerminal(status: ProposalStatus): boolean {
  return PROPOSAL_TERMINAL_STATUSES.has(status);
}

export function canCustomerAcceptProposal(status: ProposalStatus): boolean {
  return status === ProposalStatus.PENDING;
}

export function canCustomerRejectProposal(status: ProposalStatus): boolean {
  return status === ProposalStatus.PENDING;
}

export function canCreateProposal(params: {
  consultationStatus: string;
  hasPendingProposal: boolean;
  hasAcceptedProposal: boolean;
}): boolean {
  return (
    params.consultationStatus === 'ACCEPTED' &&
    !params.hasPendingProposal &&
    !params.hasAcceptedProposal
  );
}

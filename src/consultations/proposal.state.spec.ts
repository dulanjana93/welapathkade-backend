import { ProposalStatus } from '@prisma/client';
import {
  assertProposalTransition,
  canCreateProposal,
  canCustomerAcceptProposal,
  canCustomerRejectProposal,
  isProposalTerminal,
} from './proposal.state';

describe('proposal.state', () => {
  it('allows PENDING → ACCEPTED / REJECTED / SUPERSEDED', () => {
    expect(assertProposalTransition(ProposalStatus.PENDING, 'CUSTOMER_ACCEPT')).toBe(
      ProposalStatus.ACCEPTED,
    );
    expect(assertProposalTransition(ProposalStatus.PENDING, 'CUSTOMER_REJECT')).toBe(
      ProposalStatus.REJECTED,
    );
    expect(assertProposalTransition(ProposalStatus.PENDING, 'SUPERSEDE')).toBe(
      ProposalStatus.SUPERSEDED,
    );
  });

  it('rejects invalid transitions from non-PENDING', () => {
    expect(() =>
      assertProposalTransition(ProposalStatus.ACCEPTED, 'CUSTOMER_REJECT'),
    ).toThrow(/Invalid proposal transition/);
    expect(() =>
      assertProposalTransition(ProposalStatus.REJECTED, 'CUSTOMER_ACCEPT'),
    ).toThrow(/Invalid proposal transition/);
  });

  it('gates accept/reject to PENDING only', () => {
    expect(canCustomerAcceptProposal(ProposalStatus.PENDING)).toBe(true);
    expect(canCustomerRejectProposal(ProposalStatus.PENDING)).toBe(true);
    expect(canCustomerAcceptProposal(ProposalStatus.REJECTED)).toBe(false);
    expect(canCustomerRejectProposal(ProposalStatus.ACCEPTED)).toBe(false);
  });

  it('marks ACCEPTED/REJECTED/SUPERSEDED terminal', () => {
    expect(isProposalTerminal(ProposalStatus.PENDING)).toBe(false);
    expect(isProposalTerminal(ProposalStatus.ACCEPTED)).toBe(true);
    expect(isProposalTerminal(ProposalStatus.REJECTED)).toBe(true);
    expect(isProposalTerminal(ProposalStatus.SUPERSEDED)).toBe(true);
  });

  it('canCreateProposal requires ACCEPTED consultation without pending/accepted', () => {
    expect(
      canCreateProposal({
        consultationStatus: 'ACCEPTED',
        hasPendingProposal: false,
        hasAcceptedProposal: false,
      }),
    ).toBe(true);
    expect(
      canCreateProposal({
        consultationStatus: 'PENDING',
        hasPendingProposal: false,
        hasAcceptedProposal: false,
      }),
    ).toBe(false);
    expect(
      canCreateProposal({
        consultationStatus: 'ACCEPTED',
        hasPendingProposal: true,
        hasAcceptedProposal: false,
      }),
    ).toBe(false);
    expect(
      canCreateProposal({
        consultationStatus: 'ACCEPTED',
        hasPendingProposal: false,
        hasAcceptedProposal: true,
      }),
    ).toBe(false);
  });
});

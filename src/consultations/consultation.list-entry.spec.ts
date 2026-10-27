import { AppointmentStatus, ConsultationStatus } from '@prisma/client';
import type { AppointmentView } from '../payments/appointment.mapper';
import {
  toAstrologerListEntry,
  toCustomerListEntry,
} from './consultation.mapper';
import type { ProposalView } from './proposal.mapper';

const base = (status: ConsultationStatus) =>
  ({
    id: 'c-1',
    customerId: 'cust-1',
    astrologerId: 'ap-1',
    status,
    message: 'hello',
    requestedPrice: '2500.00',
    serviceNameSi: 'සේවා',
    serviceNameEn: 'Service',
    serviceId: 's-1',
    astrologerServiceId: 'as-1',
    preferredStartAt: new Date('2030-01-10T04:30:00Z'),
    preferredEndAt: new Date('2030-01-10T06:30:00Z'),
    submittedAt: new Date('2030-01-09T04:30:00Z'),
    viewedAt: null,
    respondedAt: null,
    expiresAt: new Date('2030-01-09T16:30:00Z'),
    declineReason: null,
    customer: { id: 'cust-1', name: 'Customer' },
    astrologer: { id: 'ap-1', displayName: 'Astro' },
  }) as never;

const proposal = (status: 'PENDING' | 'ACCEPTED'): ProposalView => ({
  id: 'p-1',
  consultationId: 'c-1',
  proposedStartAt: '2030-01-11T05:00:00.000Z',
  proposedEndAt: '2030-01-11T05:30:00.000Z',
  durationMinutes: 30,
  status,
  createdAt: '2030-01-09T10:00:00.000Z',
  respondedAt: null,
  localDate: '2030-01-11',
  localStartTime: '10:30',
  localEndTime: '11:00',
  timezone: 'Asia/Colombo',
});

const appointment = (status: AppointmentStatus): AppointmentView =>
  ({
    id: 'a-1',
    consultationId: 'c-1',
    proposalId: 'p-1',
    status,
    startAt: '2030-01-11T05:00:00.000Z',
    endAt: '2030-01-11T05:30:00.000Z',
    durationMinutes: 30,
    amount: '2500.00',
    currency: 'LKR',
    reservationExpiresAt: '2030-01-10T10:00:00.000Z',
    localDate: '2030-01-11',
    localStartTime: '10:30',
    localEndTime: '11:00',
    timezone: 'Asia/Colombo',
    payment: {
      id: 'pay-1',
      latestAttempt: { merchantReference: 'SECRET-REF' },
    },
    refundObligation: 'FULL_REFUND_DUE',
  }) as never;

const none = {
  pendingProposal: null,
  acceptedProposal: null,
  appointment: null,
};

const withAppt = (status: AppointmentStatus) => ({
  pendingProposal: null,
  acceptedProposal: proposal('ACCEPTED'),
  appointment: appointment(status),
});

describe('list entry lifecycle (customer + astrologer)', () => {
  it.each([
    ['pending request', ConsultationStatus.PENDING, none, 'REQUEST_PENDING'],
    ['declined', ConsultationStatus.DECLINED, none, 'REQUEST_DECLINED'],
    ['expired', ConsultationStatus.EXPIRED, none, 'REQUEST_EXPIRED'],
    ['cancelled', ConsultationStatus.CANCELLED, none, 'REQUEST_CANCELLED'],
    [
      'accepted, no proposal',
      ConsultationStatus.ACCEPTED,
      none,
      'AWAITING_PROPOSAL',
    ],
    [
      'proposal pending',
      ConsultationStatus.ACCEPTED,
      { ...none, pendingProposal: proposal('PENDING') },
      'PROPOSAL_AWAITING_CUSTOMER',
    ],
    [
      'awaiting payment',
      ConsultationStatus.ACCEPTED,
      withAppt(AppointmentStatus.PAYMENT_PENDING),
      'AWAITING_PAYMENT',
    ],
    [
      'confirmed',
      ConsultationStatus.ACCEPTED,
      withAppt(AppointmentStatus.CONFIRMED),
      'CONFIRMED',
    ],
    [
      'in progress',
      ConsultationStatus.ACCEPTED,
      withAppt(AppointmentStatus.IN_PROGRESS),
      'IN_PROGRESS',
    ],
    [
      'completed',
      ConsultationStatus.COMPLETED,
      withAppt(AppointmentStatus.COMPLETED),
      'COMPLETED',
    ],
    [
      'cancelled by customer',
      ConsultationStatus.CANCELLED,
      withAppt(AppointmentStatus.CANCELLED_BY_CUSTOMER),
      'CANCELLED_BY_CUSTOMER',
    ],
    [
      'cancelled by astrologer',
      ConsultationStatus.CANCELLED,
      withAppt(AppointmentStatus.CANCELLED_BY_ASTROLOGER),
      'CANCELLED_BY_ASTROLOGER',
    ],
    [
      'no-show customer',
      ConsultationStatus.COMPLETED,
      withAppt(AppointmentStatus.NO_SHOW_CUSTOMER),
      'NO_SHOW_CUSTOMER',
    ],
    [
      'no-show astrologer',
      ConsultationStatus.COMPLETED,
      withAppt(AppointmentStatus.NO_SHOW_ASTROLOGER),
      'NO_SHOW_ASTROLOGER',
    ],
    [
      'no-show both',
      ConsultationStatus.COMPLETED,
      withAppt(AppointmentStatus.NO_SHOW_BOTH),
      'NO_SHOW_BOTH',
    ],
  ])('%s -> %s stage for both audiences', (_n, status, lifecycle, stage) => {
    const customer = toCustomerListEntry(base(status), lifecycle);
    const astrologer = toAstrologerListEntry(base(status), lifecycle);
    expect(customer.actionability.stage).toBe(stage);
    expect(astrologer.actionability.stage).toBe(stage);
  });

  it('returns no appointment or proposal summary before one exists', () => {
    const entry = toCustomerListEntry(base(ConsultationStatus.PENDING), none);
    expect(entry.appointmentSummary).toBeNull();
    expect(entry.proposalSummary).toBeNull();
    expect(entry.preferredLocalStartTime).toBe('10:00');
  });

  it('returns the booked time, and the reservation expiry only while payment is pending', () => {
    const pending = toCustomerListEntry(
      base(ConsultationStatus.ACCEPTED),
      withAppt(AppointmentStatus.PAYMENT_PENDING),
    );
    expect(pending.appointmentSummary).toMatchObject({
      status: 'PAYMENT_PENDING',
      localDate: '2030-01-11',
      localStartTime: '10:30',
      reservationExpiresAt: '2030-01-10T10:00:00.000Z',
    });
    const confirmed = toCustomerListEntry(
      base(ConsultationStatus.ACCEPTED),
      withAppt(AppointmentStatus.CONFIRMED),
    );
    expect(confirmed.appointmentSummary?.reservationExpiresAt).toBeNull();
  });

  it('prefers the pending proposal summary', () => {
    const entry = toCustomerListEntry(base(ConsultationStatus.ACCEPTED), {
      ...none,
      pendingProposal: proposal('PENDING'),
    });
    expect(entry.proposalSummary?.status).toBe('PENDING');
  });

  it('grants list actions only where the detail rules do, per viewer', () => {
    expect(
      toAstrologerListEntry(base(ConsultationStatus.PENDING), none)
        .actionability.canRespondToRequest,
    ).toBe(true);
    expect(
      toCustomerListEntry(base(ConsultationStatus.PENDING), none).actionability
        .canRespondToRequest,
    ).toBe(false);
    expect(
      toAstrologerListEntry(base(ConsultationStatus.ACCEPTED), none)
        .actionability.canPropose,
    ).toBe(true);

    const proposalPending = { ...none, pendingProposal: proposal('PENDING') };
    expect(
      toCustomerListEntry(base(ConsultationStatus.ACCEPTED), proposalPending)
        .actionability.canRespondToProposal,
    ).toBe(true);
    expect(
      toAstrologerListEntry(base(ConsultationStatus.ACCEPTED), proposalPending)
        .actionability.canRespondToProposal,
    ).toBe(false);

    const payment = withAppt(AppointmentStatus.PAYMENT_PENDING);
    expect(
      toCustomerListEntry(base(ConsultationStatus.ACCEPTED), payment)
        .actionability.canCheckout,
    ).toBe(true);
    expect(
      toAstrologerListEntry(base(ConsultationStatus.ACCEPTED), payment)
        .actionability.canCheckout,
    ).toBe(false);
  });

  it('never leaks payment, refund or counterpart data through list entries', () => {
    const lifecycle = withAppt(AppointmentStatus.CONFIRMED);
    const customer = toCustomerListEntry(
      base(ConsultationStatus.ACCEPTED),
      lifecycle,
    );
    const astrologer = toAstrologerListEntry(
      base(ConsultationStatus.ACCEPTED),
      lifecycle,
    );
    for (const entry of [customer, astrologer]) {
      const json = JSON.stringify(entry);
      expect(json).not.toContain('SECRET-REF');
      expect(json).not.toContain('FULL_REFUND_DUE');
      expect(json).not.toContain('merchantReference');
    }
    expect(customer.astrologer).toBeDefined();
    expect(customer.customer).toBeUndefined();
    expect(astrologer.customer).toBeDefined();
    expect(astrologer.astrologer).toBeUndefined();
  });
});

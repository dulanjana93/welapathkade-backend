/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest mock idioms */
import { NotFoundException } from '@nestjs/common';
import {
  AppointmentStatus,
  ConsultationStatus,
  FinancialSnapshotStatus,
  LedgerCategory,
  LedgerEntryKind,
  PaymentStatus,
  Prisma,
  ProposalStatus,
  RefundObligation,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AdminConsultationsService } from './admin-consultations.service';

function d(value: string) {
  return new Prisma.Decimal(value);
}

describe('AdminConsultationsService', () => {
  const prisma = {
    consultation: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    consultationProposal: {
      findMany: jest.fn(),
    },
    appointment: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const service = new AdminConsultationsService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('returns an empty page without follow-up queries', async () => {
      prisma.consultation.count.mockResolvedValue(0);
      prisma.consultation.findMany.mockResolvedValue([]);

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result).toEqual({
        page: 1,
        pageSize: 20,
        total: 0,
        notes: {
          appointmentFiltersMatchAnyRelatedAppointment: true,
          listShowsLatestAppointmentByCreatedAt: true,
          readOnly: true,
        },
        items: [],
      });
      expect(prisma.consultationProposal.findMany).not.toHaveBeenCalled();
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
      expect(prisma.consultation.update).not.toHaveBeenCalled();
      expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
      expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('caps pageSize via DTO defaults used by the service', async () => {
      prisma.consultation.count.mockResolvedValue(0);
      prisma.consultation.findMany.mockResolvedValue([]);

      await service.list({ page: 2, pageSize: 100 });

      expect(prisma.consultation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 100,
          take: 100,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('applies consultation status, customer, astrologer, and date filters', async () => {
      prisma.consultation.count.mockResolvedValue(0);
      prisma.consultation.findMany.mockResolvedValue([]);

      await service.list({
        status: ConsultationStatus.PENDING,
        customerId: 'cust-1',
        astrologerId: 'astro-1',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      });

      const arg = prisma.consultation.findMany.mock.calls[0][0] as {
        where: Prisma.ConsultationWhereInput;
      };
      expect(arg.where).toEqual({
        AND: expect.arrayContaining([
          { status: ConsultationStatus.PENDING },
          { customerId: 'cust-1' },
          { astrologerId: 'astro-1' },
          {
            submittedAt: {
              gte: new Date('2026-01-01T00:00:00.000Z'),
              lt: new Date('2026-02-01T00:00:00.000Z'),
            },
          },
        ]),
      });
    });

    it('searches by exact consultation id', async () => {
      prisma.consultation.count.mockResolvedValue(0);
      prisma.consultation.findMany.mockResolvedValue([]);

      await service.list({ q: 'clxyzconsultationid001' });

      const arg = prisma.consultation.findMany.mock.calls[0][0] as {
        where: { AND: Array<{ OR?: unknown }> };
      };
      const search = arg.where.AND.find((clause) => 'OR' in clause);
      expect(search).toEqual({
        OR: expect.arrayContaining([{ id: 'clxyzconsultationid001' }]),
      });
    });

    it('searches customer phone via normalizePhone and name/displayName contains', async () => {
      prisma.consultation.count.mockResolvedValue(0);
      prisma.consultation.findMany.mockResolvedValue([]);

      await service.list({ q: '0763800354' });

      const arg = prisma.consultation.findMany.mock.calls[0][0] as {
        where: { AND: Array<{ OR?: unknown[] }> };
      };
      const search = arg.where.AND.find((clause) => Array.isArray(clause.OR));
      expect(search?.OR).toEqual(
        expect.arrayContaining([
          { customer: { phone: '+94763800354' } },
          { customer: { name: { contains: '0763800354' } } },
          { astrologer: { displayName: { contains: '0763800354' } } },
        ]),
      );
    });

    it('builds any-appointment filter clauses for status/payment/obligation', async () => {
      prisma.consultation.count.mockResolvedValue(0);
      prisma.consultation.findMany.mockResolvedValue([]);

      await service.list({
        appointmentStatus: AppointmentStatus.PAYMENT_EXPIRED,
        paymentStatus: PaymentStatus.PAID,
        hasRefundObligation: true,
        manualReviewRequired: true,
      });

      const whereArg = prisma.consultation.findMany.mock.calls[0][0] as {
        where: Prisma.ConsultationWhereInput;
      };
      expect(whereArg.where).toEqual({
        AND: [
          {
            appointments: {
              some: {
                status: AppointmentStatus.PAYMENT_EXPIRED,
                payments: { some: { status: PaymentStatus.PAID } },
                refundObligation: { not: null },
                manualReviewRequired: true,
              },
            },
          },
        ],
      });
    });

    it('displays the latest appointment by createdAt even when an older one matched filters', async () => {
      prisma.consultation.count.mockResolvedValue(1);
      prisma.consultation.findMany.mockResolvedValue([
        {
          id: 'c-1',
          status: ConsultationStatus.ACCEPTED,
          submittedAt: new Date('2026-03-01T10:00:00.000Z'),
          expiresAt: new Date('2026-03-02T10:00:00.000Z'),
          respondedAt: new Date('2026-03-01T11:00:00.000Z'),
          completedAt: null,
          requestedPrice: d('1500.00'),
          serviceNameEn: 'Horoscope',
          serviceNameSi: 'ජාතක',
          customer: { id: 'cust-1', name: 'Amal', phone: '+94771234567' },
          astrologer: {
            id: 'astro-1',
            displayName: 'Guru',
            userId: 'user-astro',
          },
        },
      ]);
      prisma.consultationProposal.findMany.mockResolvedValue([]);
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: 'apt-new',
          consultationId: 'c-1',
          status: AppointmentStatus.PAYMENT_PENDING,
          startAt: new Date('2026-03-10T04:30:00.000Z'),
          reservationExpiresAt: new Date('2026-03-01T13:00:00.000Z'),
          amount: d('1500.00'),
          currency: 'LKR',
          refundObligation: null,
          manualReviewRequired: false,
          createdAt: new Date('2026-03-01T13:00:00.000Z'),
          payments: [
            {
              id: 'pay-2',
              status: PaymentStatus.PENDING,
              amount: d('1500.00'),
              currency: 'LKR',
              paidAt: null,
              provider: 'PAYHERE',
            },
          ],
          financialSnapshot: null,
        },
        {
          id: 'apt-old',
          consultationId: 'c-1',
          status: AppointmentStatus.PAYMENT_EXPIRED,
          startAt: new Date('2026-03-09T04:30:00.000Z'),
          reservationExpiresAt: new Date('2026-03-01T12:00:00.000Z'),
          amount: d('1500.00'),
          currency: 'LKR',
          refundObligation: RefundObligation.FULL_REFUND_DUE,
          manualReviewRequired: false,
          createdAt: new Date('2026-03-01T12:00:00.000Z'),
          payments: [],
          financialSnapshot: { id: 'snap-1' },
        },
      ]);

      const mapped = await service.list({});
      expect(mapped.items[0].latestAppointment?.id).toBe('apt-new');
      expect(mapped.items[0].latestAppointment?.payment?.status).toBe(
        PaymentStatus.PENDING,
      );
      expect(mapped.items[0].flags.hasRefundObligation).toBe(false);
      expect(mapped.items[0].flags.hasSnapshot).toBe(false);
    });

    it('returns null latestAppointment when none exist and includes proposal summary', async () => {
      prisma.consultation.count.mockResolvedValue(1);
      prisma.consultation.findMany.mockResolvedValue([
        {
          id: 'c-2',
          status: ConsultationStatus.ACCEPTED,
          submittedAt: new Date('2026-03-01T10:00:00.000Z'),
          expiresAt: new Date('2026-03-02T10:00:00.000Z'),
          respondedAt: new Date('2026-03-01T11:00:00.000Z'),
          completedAt: null,
          requestedPrice: d('2000.00'),
          serviceNameEn: 'Palm',
          serviceNameSi: 'හස්ත',
          customer: { id: 'cust-2', name: 'Nimal', phone: '+94770000000' },
          astrologer: {
            id: 'astro-2',
            displayName: 'Seer',
            userId: 'user-2',
          },
        },
      ]);
      prisma.consultationProposal.findMany.mockResolvedValue([
        {
          id: 'prop-pending',
          consultationId: 'c-2',
          proposedStartAt: new Date('2026-03-11T04:30:00.000Z'),
          proposedEndAt: new Date('2026-03-11T05:00:00.000Z'),
          durationMinutes: 30,
          status: ProposalStatus.PENDING,
          createdAt: new Date('2026-03-01T12:00:00.000Z'),
          updatedAt: new Date('2026-03-01T12:00:00.000Z'),
          respondedAt: null,
        },
      ]);
      prisma.appointment.findMany.mockResolvedValue([]);

      const result = await service.list({});
      expect(result.items[0].latestAppointment).toBeNull();
      expect(result.items[0].proposal.pendingProposal?.id).toBe('prop-pending');
      expect(result.items[0].flags).toEqual({
        hasRefundObligation: false,
        manualReviewRequired: false,
        hasSnapshot: false,
      });
      expect(result.items[0]).not.toHaveProperty('message');
    });

    it('rejects reversed date ranges via shared parser', async () => {
      await expect(
        service.list({
          from: '2026-02-01T00:00:00.000Z',
          to: '2026-01-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/from must be strictly before to/);
    });
  });

  describe('getById', () => {
    it('throws 404 for unknown id', async () => {
      prisma.consultation.findUnique.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns separated statuses for payment, appointment, obligation, refund, snapshot, and ledger', async () => {
      prisma.consultation.findUnique.mockResolvedValue({
        id: 'c-9',
        status: ConsultationStatus.COMPLETED,
        requestedPrice: d('1500.00'),
        serviceNameSi: 'ජාතක',
        serviceNameEn: 'Horoscope',
        serviceId: 'svc-1',
        astrologerServiceId: 'as-1',
        preferredStartAt: new Date('2026-03-10T04:30:00.000Z'),
        preferredEndAt: null,
        submittedAt: new Date('2026-03-01T10:00:00.000Z'),
        viewedAt: new Date('2026-03-01T10:05:00.000Z'),
        respondedAt: new Date('2026-03-01T11:00:00.000Z'),
        expiresAt: new Date('2026-03-02T10:00:00.000Z'),
        completedAt: new Date('2026-03-10T05:00:00.000Z'),
        declineReason: null,
        message: 'Please check my chart',
        astrologerSummary: 'Session done',
        astrologerSummaryUpdatedAt: new Date('2026-03-10T05:01:00.000Z'),
        createdAt: new Date('2026-03-01T10:00:00.000Z'),
        updatedAt: new Date('2026-03-10T05:01:00.000Z'),
        customer: {
          id: 'cust-9',
          name: 'Amal',
          phone: '+94771234567',
          email: null,
          role: UserRole.PUBLIC,
          status: UserStatus.ACTIVE,
        },
        astrologer: {
          id: 'astro-9',
          displayName: 'Guru',
          status: 'ACTIVE',
          city: 'Colombo',
          district: 'Colombo',
          userId: 'user-astro-9',
          user: {
            id: 'user-astro-9',
            name: 'Guru User',
            phone: '+94771111111',
            email: null,
            role: UserRole.ASTROLOGER,
            status: UserStatus.ACTIVE,
          },
        },
        service: {
          id: 'svc-1',
          code: 'HOROSCOPE',
          nameEn: 'Horoscope',
          nameSi: 'ජාතක',
          status: 'ACTIVE',
        },
        proposals: [
          {
            id: 'prop-new',
            consultationId: 'c-9',
            proposedStartAt: new Date('2026-03-10T04:30:00.000Z'),
            proposedEndAt: new Date('2026-03-10T05:00:00.000Z'),
            durationMinutes: 30,
            status: ProposalStatus.ACCEPTED,
            createdAt: new Date('2026-03-01T12:00:00.000Z'),
            updatedAt: new Date('2026-03-01T12:30:00.000Z'),
            respondedAt: new Date('2026-03-01T12:30:00.000Z'),
          },
          {
            id: 'prop-old',
            consultationId: 'c-9',
            proposedStartAt: new Date('2026-03-09T04:30:00.000Z'),
            proposedEndAt: new Date('2026-03-09T05:00:00.000Z'),
            durationMinutes: 30,
            status: ProposalStatus.REJECTED,
            createdAt: new Date('2026-03-01T11:00:00.000Z'),
            updatedAt: new Date('2026-03-01T11:30:00.000Z'),
            respondedAt: new Date('2026-03-01T11:30:00.000Z'),
          },
        ],
        appointments: [
          {
            id: 'apt-1',
            consultationId: 'c-9',
            proposalId: 'prop-new',
            customerId: 'cust-9',
            astrologerId: 'astro-9',
            startAt: new Date('2026-03-10T04:30:00.000Z'),
            endAt: new Date('2026-03-10T05:00:00.000Z'),
            durationMinutes: 30,
            status: AppointmentStatus.COMPLETED,
            amount: d('1500.00'),
            currency: 'LKR',
            reservationExpiresAt: new Date('2026-03-01T13:00:00.000Z'),
            confirmedAt: new Date('2026-03-01T12:40:00.000Z'),
            sessionStartedAt: new Date('2026-03-10T04:30:00.000Z'),
            sessionEndedAt: new Date('2026-03-10T05:00:00.000Z'),
            actualDurationSeconds: 1800,
            cancelledAt: null,
            cancelReason: null,
            noShowRecordedAt: null,
            refundObligation: RefundObligation.FULL_REFUND_DUE,
            refundObligationRecordedAt: new Date('2026-03-10T06:00:00.000Z'),
            manualReviewRequired: false,
            createdAt: new Date('2026-03-01T12:35:00.000Z'),
            updatedAt: new Date('2026-03-10T06:00:00.000Z'),
            payments: [
              {
                id: 'pay-1',
                status: PaymentStatus.PAID,
                provider: 'PAYHERE',
                amount: d('1500.00'),
                currency: 'LKR',
                paidAt: new Date('2026-03-01T12:40:00.000Z'),
                createdAt: new Date('2026-03-01T12:35:00.000Z'),
                updatedAt: new Date('2026-03-01T12:40:00.000Z'),
                attempts: [
                  {
                    id: 'att-1',
                    merchantReference: 'wp_abc',
                    providerPaymentId: 'ph_1',
                    status: PaymentStatus.PAID,
                    provider: 'PAYHERE',
                    requiresReview: false,
                    createdAt: new Date('2026-03-01T12:35:00.000Z'),
                    updatedAt: new Date('2026-03-01T12:40:00.000Z'),
                  },
                ],
              },
            ],
            payHereRefunds: [],
            financialSnapshot: {
              id: 'snap-1',
              status: FinancialSnapshotStatus.POSTED,
              currency: 'LKR',
              grossAmount: d('1500.00'),
              basis: 'GROSS_CONSULTATION_AMOUNT',
              astrologerId: 'astro-9',
              astrologerPercent: d('80.00'),
              astrologerAmount: d('1200.00'),
              customerReferrerUserId: null,
              customerReferralPercent: d('0.00'),
              customerReferralAmount: d('0.00'),
              astrologerReferrerUserId: null,
              astrologerReferralPercent: d('0.00'),
              astrologerReferralAmount: d('0.00'),
              platformPercent: d('20.00'),
              platformAmount: d('300.00'),
              completedAt: new Date('2026-03-10T05:00:00.000Z'),
              holdExpiresAt: new Date('2026-03-11T05:00:00.000Z'),
              postedAt: new Date('2026-03-11T05:01:00.000Z'),
              reversedAt: null,
              createdAt: new Date('2026-03-11T05:00:00.000Z'),
            },
            ledgerEntries: [
              {
                id: 'led-1',
                category: LedgerCategory.ASTROLOGER_EARNING,
                kind: LedgerEntryKind.CREDIT,
                amount: d('1200.00'),
                currency: 'LKR',
                userId: 'user-astro-9',
                snapshotId: 'snap-1',
                reversesEntryId: null,
                createdAt: new Date('2026-03-11T05:01:00.000Z'),
              },
              {
                id: 'led-2',
                category: LedgerCategory.PLATFORM_RESIDUAL,
                kind: LedgerEntryKind.CREDIT,
                amount: d('300.00'),
                currency: 'LKR',
                userId: null,
                snapshotId: 'snap-1',
                reversesEntryId: null,
                createdAt: new Date('2026-03-11T05:01:00.000Z'),
              },
            ],
          },
        ],
      });

      const detail = await service.getById('c-9');

      expect(detail.consultation.status).toBe(ConsultationStatus.COMPLETED);
      expect(detail.consultation.message).toBe('Please check my chart');
      expect(detail.consultation).not.toHaveProperty('clientIdempotencyKey');
      expect(detail.consultation).not.toHaveProperty('requestFingerprint');
      expect(detail.proposals).toHaveLength(2);
      expect(detail.acceptedProposal?.id).toBe('prop-new');
      expect(detail.appointments).toHaveLength(1);

      const appointment = detail.appointments[0];
      expect(appointment.status).toBe(AppointmentStatus.COMPLETED);
      expect(appointment.payment?.status).toBe(PaymentStatus.PAID);
      expect(appointment.payment?.attempts[0].merchantReference).toBe('wp_abc');
      expect(appointment.refundObligation).toBe(
        RefundObligation.FULL_REFUND_DUE,
      );
      expect(appointment.refunds).toEqual([]);
      expect(appointment.snapshot?.status).toBe(
        FinancialSnapshotStatus.POSTED,
      );
      expect(appointment.ledger.hasCredits).toBe(true);
      expect(appointment.ledger.creditCount).toBe(2);
      expect(appointment.ledger.entries[0].kind).toBe(LedgerEntryKind.CREDIT);
      expect(detail.notes).toEqual({
        refundObligationIsNotGatewayRefund: true,
        paymentCaptureDoesNotCreditWallet: true,
        readOnly: true,
      });
      expect(prisma.consultation.update).not.toHaveBeenCalled();
      expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
    });
  });
});

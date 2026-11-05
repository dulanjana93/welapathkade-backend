import {
  AppointmentStatus,
  PaymentProvider,
  PaymentStatus,
} from '@prisma/client';
import { toAppointmentView } from './appointment.mapper';
import { attemptRequiresReconciliation } from './attempt-reconciliation';

function viewFor(attempt: {
  status: PaymentStatus;
  requiresReview: boolean;
  openChargeSlot: string | null;
}) {
  return toAppointmentView({
    id: 'apt-1',
    consultationId: 'c-1',
    proposalId: 'p-1',
    status: AppointmentStatus.PAYMENT_PENDING,
    startAt: new Date('2026-10-01T04:30:00.000Z'),
    endAt: new Date('2026-10-01T05:00:00.000Z'),
    durationMinutes: 30,
    amount: '1500.00',
    currency: 'LKR',
    reservationExpiresAt: new Date('2026-10-01T05:00:00.000Z'),
    confirmedAt: null,
    payments: [
      {
        id: 'pay-1',
        status: attempt.status,
        provider: PaymentProvider.PAYHERE,
        amount: '1500.00',
        currency: 'LKR',
        paidAt:
          attempt.status === PaymentStatus.PAID
            ? new Date('2026-10-01T04:00:00.000Z')
            : null,
        attempts: [
          {
            id: 'att-1',
            merchantReference: 'sc_ref',
            provider: PaymentProvider.PAYHERE,
            createdAt: new Date('2026-10-01T03:00:00.000Z'),
            ...attempt,
          },
        ],
      },
    ],
  } as never);
}

describe('appointment reconciliationRequired', () => {
  it('reports true while the open charge slot is held', () => {
    const attempt = {
      status: PaymentStatus.PENDING,
      requiresReview: false,
      openChargeSlot: 'slot-internal',
    };
    const view = viewFor(attempt);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(true);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(
      attemptRequiresReconciliation(attempt),
    );
    expect(JSON.stringify(view)).not.toContain('openChargeSlot');
    expect(JSON.stringify(view)).not.toContain('slot-internal');
  });

  it('reports true when the attempt requires review', () => {
    const attempt = {
      status: PaymentStatus.PENDING,
      requiresReview: true,
      openChargeSlot: null,
    };
    const view = viewFor(attempt);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(true);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(
      attemptRequiresReconciliation(attempt),
    );
  });

  it('reports false for an unsent failure whose slot was released', () => {
    const attempt = {
      status: PaymentStatus.FAILED,
      requiresReview: false,
      openChargeSlot: null,
    };
    const view = viewFor(attempt);
    expect(view.payment?.latestAttempt?.status).toBe(PaymentStatus.FAILED);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(false);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(
      attemptRequiresReconciliation(attempt),
    );
  });

  it('does not report reconciliation for a verified paid attempt', () => {
    const attempt = {
      status: PaymentStatus.PAID,
      requiresReview: true,
      openChargeSlot: 'slot-internal',
    };
    const view = viewFor(attempt);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(false);
    expect(view.payment?.latestAttempt?.reconciliationRequired).toBe(
      attemptRequiresReconciliation(attempt),
    );
    expect(JSON.stringify(view)).not.toContain('openChargeSlot');
    expect(JSON.stringify(view)).not.toContain('slot-internal');
  });

  it('keeps a definitive sent failure that still holds the slot under reconciliation', () => {
    const attempt = {
      status: PaymentStatus.FAILED,
      requiresReview: true,
      openChargeSlot: 'slot-internal',
    };
    expect(viewFor(attempt).payment?.latestAttempt?.reconciliationRequired).toBe(
      true,
    );
    expect(attemptRequiresReconciliation(attempt)).toBe(true);
  });
});

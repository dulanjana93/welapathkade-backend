import { ConsultationStatus } from '@prisma/client';
import {
  deriveFollowUpMessaging,
  followUpExpiresAt,
  isFollowUpWindowOpen,
  normalizeMessageBody,
  normalizeSummaryText,
} from './consultation-follow-up';
import { FOLLOW_UP_WINDOW_HOURS } from './consultation-follow-up.constants';

describe('consultation follow-up helpers', () => {
  const completedAt = new Date('2026-10-17T12:00:00.000Z');

  it('derives expiry exactly 48h after completedAt', () => {
    const expires = followUpExpiresAt(completedAt)!;
    expect(expires.toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(FOLLOW_UP_WINDOW_HOURS).toBe(48);
  });

  it('window is open before expiry and closed at/after expiry', () => {
    expect(
      isFollowUpWindowOpen(completedAt, new Date('2026-10-19T11:59:59.999Z')),
    ).toBe(true);
    expect(
      isFollowUpWindowOpen(completedAt, new Date('2026-10-19T12:00:00.000Z')),
    ).toBe(false);
    expect(isFollowUpWindowOpen(null)).toBe(false);
  });

  it('customer canSend respects remaining quota inside the window', () => {
    const open = deriveFollowUpMessaging({
      consultationStatus: ConsultationStatus.COMPLETED,
      appointmentStatus: 'COMPLETED',
      completedAt,
      customerMessagesSent: 4,
      viewerIsCustomer: true,
      now: new Date('2026-10-18T00:00:00.000Z'),
    });
    expect(open.isOpen).toBe(true);
    expect(open.customerMessagesRemaining).toBe(1);
    expect(open.canSend).toBe(true);

    const limited = deriveFollowUpMessaging({
      consultationStatus: ConsultationStatus.COMPLETED,
      appointmentStatus: 'COMPLETED',
      completedAt,
      customerMessagesSent: 5,
      viewerIsCustomer: true,
      now: new Date('2026-10-18T00:00:00.000Z'),
    });
    expect(limited.canSend).toBe(false);
    expect(limited.customerMessagesRemaining).toBe(0);
  });

  it('astrologer canSend ignores customer quota while window is open', () => {
    const view = deriveFollowUpMessaging({
      consultationStatus: ConsultationStatus.COMPLETED,
      appointmentStatus: 'COMPLETED',
      completedAt,
      customerMessagesSent: 5,
      viewerIsCustomer: false,
      now: new Date('2026-10-18T00:00:00.000Z'),
    });
    expect(view.canSend).toBe(true);
  });

  it('unavailable before successful completion', () => {
    const view = deriveFollowUpMessaging({
      consultationStatus: ConsultationStatus.ACCEPTED,
      appointmentStatus: 'CONFIRMED',
      completedAt: null,
      customerMessagesSent: 0,
      viewerIsCustomer: true,
    });
    expect(view.available).toBe(false);
    expect(view.canSend).toBe(false);
  });

  it('normalizes summary and message text', () => {
    expect(normalizeSummaryText('  hello  ')).toBe('hello');
    expect(normalizeSummaryText('   ')).toBeNull();
    expect(normalizeSummaryText(undefined)).toBeNull();
    expect(normalizeMessageBody('  hi  ')).toBe('hi');
  });
});

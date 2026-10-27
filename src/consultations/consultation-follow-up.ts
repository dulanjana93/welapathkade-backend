import { ConsultationStatus } from '@prisma/client';
import {
  FOLLOW_UP_CUSTOMER_MESSAGE_LIMIT,
  FOLLOW_UP_WINDOW_HOURS,
} from './consultation-follow-up.constants';

export type FollowUpMessagingView = {
  /** True only when the consultation completed successfully and has a completion timestamp. */
  available: boolean;
  /** True while `now` is strictly before `expiresAt`. */
  isOpen: boolean;
  /** UTC ISO instant: completedAt + 48h. Null when unavailable. */
  expiresAt: string | null;
  /** Count of successfully persisted customer messages. */
  customerMessagesSent: number;
  /** Remaining customer sends (0 after limit or when closed). */
  customerMessagesRemaining: number;
  /** Viewer may send a new message right now. */
  canSend: boolean;
};

/**
 * Derive the exclusive send-window end from the server completion timestamp.
 * Returns null when there is no authoritative completion time.
 */
export function followUpExpiresAt(
  completedAt: Date | null | undefined,
): Date | null {
  if (!completedAt) return null;
  return new Date(
    completedAt.getTime() + FOLLOW_UP_WINDOW_HOURS * 60 * 60 * 1000,
  );
}

export function isFollowUpWindowOpen(
  completedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const expires = followUpExpiresAt(completedAt);
  if (!expires) return false;
  return now.getTime() < expires.getTime();
}

export function isSuccessfullyCompleted(input: {
  consultationStatus: ConsultationStatus;
  appointmentStatus?: string | null;
}): boolean {
  return (
    input.consultationStatus === ConsultationStatus.COMPLETED &&
    (input.appointmentStatus == null || input.appointmentStatus === 'COMPLETED')
  );
}

export function deriveFollowUpMessaging(input: {
  consultationStatus: ConsultationStatus;
  appointmentStatus?: string | null;
  completedAt: Date | null | undefined;
  customerMessagesSent: number;
  /** True when the authenticated viewer is the customer of this consultation. */
  viewerIsCustomer: boolean;
  now?: Date;
}): FollowUpMessagingView {
  const now = input.now ?? new Date();
  const available = isSuccessfullyCompleted({
    consultationStatus: input.consultationStatus,
    appointmentStatus: input.appointmentStatus,
  });
  const expires = available ? followUpExpiresAt(input.completedAt) : null;
  const isOpen = available && !!expires && now.getTime() < expires.getTime();
  const sent = Math.max(0, input.customerMessagesSent);
  const remaining = Math.max(0, FOLLOW_UP_CUSTOMER_MESSAGE_LIMIT - sent);
  const canSend = isOpen && (input.viewerIsCustomer ? remaining > 0 : true);

  return {
    available,
    isOpen,
    expiresAt: expires ? expires.toISOString() : null,
    customerMessagesSent: sent,
    customerMessagesRemaining: remaining,
    canSend,
  };
}

/** Normalize optional summary: trim; empty → null. */
export function normalizeSummaryText(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Normalize message body: trim; empty is invalid (caller rejects). */
export function normalizeMessageBody(raw: string): string {
  return raw.trim();
}

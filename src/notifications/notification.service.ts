import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  Prisma,
  UserStatus,
  type Notification,
  type NotificationType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FCM_PROVIDER,
  maskToken,
  type FcmProvider,
  type FcmSendResult,
} from './fcm-provider.interface';
import { renderNotificationText } from './notification.templates';

/** Prisma client or an interactive-transaction client. */
export type NotificationDb = PrismaService | Prisma.TransactionClient;

export const NOTIFICATION_TITLE_MAX = 160;
export const NOTIFICATION_BODY_MAX = 500;
export const NOTIFICATION_REFERENCE_MAX = 191;

export class InvalidNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNotificationError';
  }
}

type NotificationBase = {
  /** Recipient User.id (never AstrologerProfile.id). */
  userId: string;
  /** Generic, localized text. Must not contain consultation content. */
  title: string;
  body: string;
};

/**
 * Typed event inputs. The idempotency `referenceId` is never supplied by the
 * caller; it is derived from the event's own entity id (see
 * `deriveReferenceId`), while `consultationId` stays the navigation target.
 *
 *  - CONSULTATION_*  -> deduplicated by consultation id
 *  - PROPOSAL_*      -> deduplicated by proposal id (one consultation can
 *                       have several proposals over time)
 *  - APPOINTMENT_*   -> deduplicated by appointment id
 */
export type ConsultationEventInput = NotificationBase & {
  type:
    | 'CONSULTATION_REQUESTED'
    | 'CONSULTATION_ACCEPTED'
    | 'CONSULTATION_DECLINED';
  consultationId: string;
  proposalId?: never;
  appointmentId?: never;
};

export type ProposalEventInput = NotificationBase & {
  type: 'PROPOSAL_CREATED' | 'PROPOSAL_ACCEPTED' | 'PROPOSAL_REJECTED';
  consultationId: string;
  proposalId: string;
  appointmentId?: never;
};

export type AppointmentEventInput = NotificationBase & {
  type: 'APPOINTMENT_CONFIRMED';
  consultationId: string;
  appointmentId: string;
  proposalId?: never;
};

export type CreateNotificationInput =
  ConsultationEventInput | ProposalEventInput | AppointmentEventInput;

/**
 * - CREATED: a new row was inserted.
 * - DUPLICATE: the event was already recorded; the existing row is returned.
 * - DUPLICATE_UNREADABLE: the insert hit the unique key but the existing row
 *   could not be read (e.g. committed after this transaction's snapshot). The
 *   event IS already recorded; no row is fabricated and callers must not
 *   deliver anything for it from this call.
 */
export type CreateNotificationResult =
  | { status: 'CREATED'; notification: Notification }
  | { status: 'DUPLICATE'; notification: Notification }
  | { status: 'DUPLICATE_UNREADABLE' };

export type DeliveryOutcome =
  | { status: 'NOT_FOUND' }
  | { status: 'ERROR' }
  | { status: 'ALREADY_SENT' }
  | { status: 'RECIPIENT_INACTIVE' }
  | { status: 'NO_DEVICES' }
  | {
      status: 'COMPLETED';
      sent: number;
      skipped: number;
      failed: number;
      invalidTokensRemoved: number;
    };

/**
 * The part of an event the business code knows: what happened and which
 * entities it concerns. Recipient, language and text are resolved by the
 * service. Mirrors the typed `CreateNotificationInput` union.
 */
export type NotificationEventRef =
  | {
      type:
        | 'CONSULTATION_REQUESTED'
        | 'CONSULTATION_ACCEPTED'
        | 'CONSULTATION_DECLINED';
      consultationId: string;
    }
  | {
      type: 'PROPOSAL_CREATED' | 'PROPOSAL_ACCEPTED' | 'PROPOSAL_REJECTED';
      consultationId: string;
      proposalId: string;
    }
  | {
      type: 'APPOINTMENT_CONFIRMED';
      consultationId: string;
      appointmentId: string;
    };

/**
 * Persistence and delivery are deliberately separate:
 *
 *  - `create` only writes the row. Pass the caller's transaction client so the
 *    row commits atomically with the business change. It never opens its own
 *    transaction.
 *  - `deliver` must be called AFTER the business transaction has committed and
 *    never from inside `withAstrologerLock`. It never throws.
 *
 * `sentAt` means "a push provider accepted at least one device send". It does
 * not mean the user saw anything, and an unsent row is not retried
 * automatically (no worker exists).
 *
 * Phase 6C usage from business code, inside the business transaction:
 *   `const id = await notifications.notifyUser(tx, userId, ref)` (or
 *   `notifyAstrologerProfile`), then AFTER the transaction/lock resolved:
 *   `notifications.deliverAfterCommit(ids)`.
 */
@Injectable()
export class NotificationService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  /** Deliveries started after commit and not yet settled. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FCM_PROVIDER) private readonly fcm: FcmProvider,
  ) {}

  async create(
    input: CreateNotificationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CreateNotificationResult> {
    // Validation and reference derivation happen before any database call.
    const referenceId = deriveReferenceId(input);
    validateInput(input, referenceId);
    const db: NotificationDb = tx ?? this.prisma;
    const data = buildData(input);

    try {
      const notification = await db.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          referenceId,
          title: input.title,
          body: input.body,
          data,
        },
      });
      return { status: 'CREATED', notification };
    } catch (error) {
      // Only a conflict on the idempotency key means "already recorded".
      // Every other error (FK, connection, other constraints) propagates so
      // the caller's transaction rolls back.
      if (!isIdempotencyKeyViolation(error)) throw error;
    }

    // A unique conflict does not abort a MySQL transaction, so reading with
    // the same client is safe. Under REPEATABLE READ the conflicting row may
    // have been committed after this transaction's snapshot and be invisible
    // here; that must not fail the caller's business transaction.
    const existing = await db.notification.findUnique({
      where: {
        userId_type_referenceId: {
          userId: input.userId,
          type: input.type,
          referenceId,
        },
      },
    });
    if (existing) return { status: 'DUPLICATE', notification: existing };

    this.logger.warn(
      `duplicate notification not readable type=${input.type} referenceId=${referenceId}`,
    );
    return { status: 'DUPLICATE_UNREADABLE' };
  }

  /**
   * Record an event for a user inside the caller's transaction.
   *
   * Returns the new notification id ONLY when a row was created; `null` for
   * duplicates and for the one tolerated failure (invalid notification input,
   * a programming error that must not break the business operation). Every
   * other error (database, foreign key, deadlock, ...) propagates so the
   * caller's transaction rolls back.
   *
   * `language` avoids a lookup when the caller already has the recipient's
   * language; pass `undefined` to have it read from the user row.
   */
  async notifyUser(
    tx: Prisma.TransactionClient,
    userId: string,
    ref: NotificationEventRef,
    language?: string | null,
  ): Promise<string | null> {
    const lang =
      language !== undefined
        ? language
        : (
            await tx.user.findUnique({
              where: { id: userId },
              select: { language: true },
            })
          )?.language;
    const text = renderNotificationText(ref.type, lang);
    try {
      const result = await this.create({ ...ref, userId, ...text }, tx);
      return result.status === 'CREATED' ? result.notification.id : null;
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) throw error;
      // Never log ids, text or user details; the type is enough to locate it.
      this.logger.warn(`notification skipped: invalid input type=${ref.type}`);
      return null;
    }
  }

  /**
   * Same as `notifyUser`, for an astrologer identified by AstrologerProfile.id
   * (consultations, proposals and appointments store the profile id, not the
   * user id). Resolves `AstrologerProfile.userId` and the user's language in
   * one query on the caller's transaction client.
   */
  async notifyAstrologerProfile(
    tx: Prisma.TransactionClient,
    astrologerProfileId: string,
    ref: NotificationEventRef,
  ): Promise<string | null> {
    const profile = await tx.astrologerProfile.findUnique({
      where: { id: astrologerProfileId },
      select: { userId: true, user: { select: { language: true } } },
    });
    if (!profile) return null;
    return this.notifyUser(tx, profile.userId, ref, profile.user.language);
  }

  /**
   * Start best-effort delivery for already-committed notifications.
   *
   * Call only after the business transaction (and any lock) has completed.
   * Does not wait for delivery, never throws and never rejects; in-flight
   * deliveries are tracked so `flushPending` can await them.
   */
  deliverAfterCommit(ids: ReadonlyArray<string | null | undefined>): void {
    for (const id of ids) {
      if (!id) continue;
      const run: Promise<void> = this.deliver(id)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.pending.delete(run);
        });
      this.pending.add(run);
    }
  }

  /** Resolves once every delivery started so far has settled. Never rejects. */
  async flushPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flushPending();
  }

  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification | null> {
    const db: NotificationDb = tx ?? this.prisma;
    return db.notification.findUnique({ where: { id } });
  }

  /**
   * Best-effort push to all of the recipient's devices. Call after commit.
   * Never throws; provider and database errors are logged and reported.
   */
  async deliver(notificationId: string): Promise<DeliveryOutcome> {
    try {
      return await this.deliverUnsafe(notificationId);
    } catch (error) {
      this.logger.error(
        `deliver failed notificationId=${notificationId} error=${errorName(error)}`,
      );
      return { status: 'ERROR' };
    }
  }

  private async deliverUnsafe(
    notificationId: string,
  ): Promise<DeliveryOutcome> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        user: {
          select: {
            status: true,
            devices: { select: { id: true, fcmToken: true } },
          },
        },
      },
    });
    if (!notification) return { status: 'NOT_FOUND' };
    if (notification.sentAt) return { status: 'ALREADY_SENT' };
    if (notification.user.status !== UserStatus.ACTIVE) {
      return { status: 'RECIPIENT_INACTIVE' };
    }
    const devices = notification.user.devices;
    if (devices.length === 0) return { status: 'NO_DEVICES' };

    const payload = notification.data as Record<string, string>;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const invalidDeviceIds: string[] = [];

    for (const device of devices) {
      const result = await this.sendSafely({
        token: device.fcmToken,
        title: notification.title,
        body: notification.body,
        data: payload,
      });
      if (result.status === 'SENT') {
        sent += 1;
      } else if (result.status === 'SKIPPED') {
        skipped += 1;
      } else {
        failed += 1;
        this.logger.warn(
          `push failed notificationId=${notification.id} type=${notification.type} token=${maskToken(device.fcmToken)} error=${result.error} retryable=${result.retryable}`,
        );
        if (result.invalidToken) invalidDeviceIds.push(device.id);
      }
    }

    let invalidTokensRemoved = 0;
    if (invalidDeviceIds.length > 0) {
      const removed = await this.prisma.userDevice.deleteMany({
        where: { id: { in: invalidDeviceIds }, userId: notification.userId },
      });
      invalidTokensRemoved = removed.count;
    }

    // Only real provider attempts count. SKIPPED means nothing was tried.
    if (sent + failed > 0) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { attempts: { increment: 1 } },
      });
    }
    // sentAt is set only on a provider-accepted send, and never overwritten.
    if (sent > 0) {
      await this.prisma.notification.updateMany({
        where: { id: notification.id, sentAt: null },
        data: { sentAt: new Date() },
      });
    }

    return {
      status: 'COMPLETED',
      sent,
      skipped,
      failed,
      invalidTokensRemoved,
    };
  }

  private async sendSafely(
    input: Parameters<FcmProvider['send']>[0],
  ): Promise<FcmSendResult> {
    try {
      return await this.fcm.send(input);
    } catch (error) {
      // Providers should not throw, but a bug must not become an HTTP error.
      return {
        status: 'FAILED',
        invalidToken: false,
        retryable: true,
        error: errorName(error),
      };
    }
  }
}

/** Control characters other than tab, line feed and carriage return. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

const CONSULTATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'CONSULTATION_REQUESTED',
  'CONSULTATION_ACCEPTED',
  'CONSULTATION_DECLINED',
]);
const PROPOSAL_TYPES: ReadonlySet<NotificationType> = new Set([
  'PROPOSAL_CREATED',
  'PROPOSAL_ACCEPTED',
  'PROPOSAL_REJECTED',
]);

/**
 * The idempotency reference for an event, derived from its type. Throws before
 * any database access when the required entity id is missing or when an id
 * that does not belong to the event type is supplied.
 */
export function deriveReferenceId(input: CreateNotificationInput): string {
  // Runtime guards cover JS callers and casts that bypass the union type.
  const { type, consultationId, proposalId, appointmentId } = input as {
    type: NotificationType;
    consultationId?: unknown;
    proposalId?: unknown;
    appointmentId?: unknown;
  };

  const required = (name: string, value: unknown): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidNotificationError(`${name} is required for ${type}`);
    }
    return value;
  };
  const forbidden = (name: string, value: unknown) => {
    if (value !== undefined && value !== null) {
      throw new InvalidNotificationError(`${name} is not allowed for ${type}`);
    }
  };

  required('consultationId', consultationId);
  if (CONSULTATION_TYPES.has(type)) {
    forbidden('proposalId', proposalId);
    forbidden('appointmentId', appointmentId);
    return required('consultationId', consultationId);
  }
  if (PROPOSAL_TYPES.has(type)) {
    forbidden('appointmentId', appointmentId);
    return required('proposalId', proposalId);
  }
  if (type === 'APPOINTMENT_CONFIRMED') {
    forbidden('proposalId', proposalId);
    return required('appointmentId', appointmentId);
  }
  throw new InvalidNotificationError(
    `unsupported notification type ${String(type)}`,
  );
}

function validateInput(input: CreateNotificationInput, referenceId: string) {
  for (const [name, value] of [
    ['userId', input.userId],
    ['title', input.title],
    ['body', input.body],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidNotificationError(`${name} is required`);
    }
  }
  if (referenceId.length > NOTIFICATION_REFERENCE_MAX) {
    throw new InvalidNotificationError('reference id is too long');
  }
  if (input.title.length > NOTIFICATION_TITLE_MAX) {
    throw new InvalidNotificationError('title is too long');
  }
  if (input.body.length > NOTIFICATION_BODY_MAX) {
    throw new InvalidNotificationError('body is too long');
  }
  if (hasControlCharacters(input.title) || hasControlCharacters(input.body)) {
    throw new InvalidNotificationError('text contains control characters');
  }
}

/** Canonical FCM data: routing ids only; every key always present. */
function buildData(input: CreateNotificationInput): Prisma.InputJsonObject {
  return {
    type: input.type,
    consultationId: input.consultationId,
    proposalId: input.proposalId ?? '',
    appointmentId: input.appointmentId ?? '',
  };
}

const IDEMPOTENCY_INDEX = 'userId_type_referenceId';

/**
 * True only for a P2002 on the (userId, type, referenceId) key. The table's
 * only other unique column is the generated primary key, so an unknown target
 * is treated as the idempotency key; a known different target is rethrown.
 */
function isIdempotencyKeyViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const target: unknown = error.meta?.target;
  if (typeof target === 'string') return target.includes(IDEMPOTENCY_INDEX);
  if (Array.isArray(target)) {
    return ['userId', 'type', 'referenceId'].every((f) => target.includes(f));
  }
  return true;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name.slice(0, 80);
  return 'UnknownError';
}

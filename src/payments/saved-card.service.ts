import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  PaymentProvider,
  Prisma,
  SavedCardConsentEventType,
  SavedCardFailureReason,
  SavedCardStatus,
  type SavedPaymentMethod,
  type User,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  assessBillingProfile,
  billingProfileIncompleteException,
} from '../users/billing-profile';
import { BankAccountCrypto } from '../withdrawals/bank-account.crypto';
import {
  payHereErrorCategory,
  payHereErrorName,
  type PayHereLogSink,
} from './payhere/payhere-diagnostics';
import {
  createPayHereDiagnosticLogger,
  PAYHERE_FILE_LOG,
  type PayHereFileLogSink,
} from './payhere/payhere-file-log.sink';
import { PayHereNotificationError } from './payhere/payhere-signature';
import type { PayHereGateway } from './payhere/payhere.gateway';
import { PAYHERE_MERCHANT } from './payhere-refund.service';
import {
  AUTOMATIC_PAYMENT_CONSENT_TEXT,
  AUTOMATIC_PAYMENT_CONSENT_VERSION,
} from './saved-card.consent';

type PreapprovalClient = Pick<
  PayHereGateway,
  'createPreapproval' | 'verifyPreapproval'
>;

export type SavedCardView = {
  id: string;
  status: SavedCardStatus;
  authorizationEnabled: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  consentVersion: string;
  consentedAt: Date;
  revokedAt: Date | null;
  removedAt: Date | null;
};

/**
 * What the app saw when the PayHere page closed. Informational only: it can
 * fail an attempt early (CANCELLED) but it can never activate a card.
 */
export const REGISTRATION_CLIENT_OUTCOMES = [
  'RETURNED',
  'CANCELLED',
  'CLOSED',
] as const;
export type RegistrationClientOutcome =
  (typeof REGISTRATION_CLIENT_OUTCOMES)[number];

/** Customer-facing failure reason. Internal reasons map onto these. */
export type FailedRegistrationReason =
  'DECLINED' | 'CANCELLED' | 'NOT_CONFIRMED';

/**
 * Customer-visible terminal registration failure: the newest registration
 * attempt ended without a verified PayHere success. Not a chargeable payment
 * method and never blocks a new registration.
 */
export type FailedRegistrationView = {
  id: string;
  status: typeof SavedCardStatus.FAILED;
  reason: FailedRegistrationReason;
  consentedAt: Date;
  failedAt: Date | null;
};

/** Final outcome of one registration flow. Never PENDING. */
export type RegistrationResult = {
  status: SavedCardStatus;
  savedCard: SavedCardView | null;
  failedRegistration: FailedRegistrationView | null;
};

/**
 * Backstop only. A registration whose app never called `complete` (app killed,
 * network lost) is failed by the expiry sweep after this many minutes. The
 * primary path is `complete`, and a new `start` supersedes an open attempt
 * immediately, so this window never blocks a customer.
 */
export const ABANDONED_REGISTRATION_MINUTES = 30;

const RETIRED = {
  authorizationEnabled: false,
  tokenCiphertext: null,
  tokenIv: null,
  tokenTag: null,
  openCardSlot: null,
};

/**
 * Saved-card registration only. This service never charges a card and never
 * creates a consultation payment, appointment, wallet credit, or ledger row.
 */
@Injectable()
export class SavedCardService {
  private readonly logger: PayHereLogSink;

  /**
   * How long `complete` waits, inside the request, for PayHere's signed
   * notification to land after the customer returns from the PayHere page.
   * This is a bounded confirmation window, not a pending state: when it ends
   * the attempt is ACTIVE or FAILED.
   */
  completionWait = { totalMs: 8000, intervalMs: 1000 };
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYHERE_MERCHANT)
    private readonly payhere: PreapprovalClient | null,
    private readonly crypto: BankAccountCrypto,
    @Optional()
    @Inject(PAYHERE_FILE_LOG)
    fileLog?: PayHereFileLogSink | null,
  ) {
    this.logger = createPayHereDiagnosticLogger(SavedCardService.name, {
      fileSink: fileLog === undefined ? undefined : fileLog,
    });
  }

  consent() {
    return {
      version: AUTOMATIC_PAYMENT_CONSENT_VERSION,
      text: AUTOMATIC_PAYMENT_CONSENT_TEXT,
    };
  }

  async list(userId: string) {
    const [rows, latestAttempt] = await Promise.all([
      this.prisma.savedPaymentMethod.findMany({
        where: {
          userId,
          status: SavedCardStatus.ACTIVE,
          authorizationEnabled: true,
          revokedAt: null,
          removedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
      // The newest attempt decides whether a failure is still relevant. An
      // older FAILED row must not surface after a later card or attempt.
      this.prisma.savedPaymentMethod.findFirst({
        where: {
          userId,
          status: {
            in: [
              SavedCardStatus.PENDING,
              SavedCardStatus.FAILED,
              SavedCardStatus.ACTIVE,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const failed =
      latestAttempt?.status === SavedCardStatus.FAILED ? latestAttempt : null;
    return {
      consent: this.consent(),
      methods: rows.map(toView),
      /**
       * @deprecated Always null. Registration is no longer a customer-visible
       * pending workflow. Kept so older app builds keep parsing the response
       * and never block a new registration.
       */
      pendingRegistration: null,
      failedRegistration: failed ? toFailedRegistration(failed) : null,
    };
  }

  async start(user: User, accepted: boolean) {
    if (accepted !== true) {
      throw new BadRequestException('Automatic payment consent is required');
    }
    const billing = assessBillingProfile(user);
    if (!billing.complete) {
      throw billingProfileIncompleteException(billing.missingFields);
    }
    if (!this.payhere) {
      throw new BadRequestException(
        'PayHere saved cards require PAYHERE_MODE=sandbox or live',
      );
    }
    // An earlier attempt that never completed must not block the customer.
    // Starting again supersedes it (FAILED, slot released). A late PayHere
    // success for it is handled as a late authorization in handleNotify.
    const open = await this.prisma.savedPaymentMethod.findFirst({
      where: { openCardSlot: user.id },
    });
    if (open && open.status !== SavedCardStatus.PENDING) {
      // Only PENDING holds the slot. Anything else is a data error.
      throw new ConflictException('A card registration is already in progress');
    }

    const now = new Date();
    const merchantReference = `pa_${randomBytes(12).toString('hex')}`;
    let created: SavedPaymentMethod;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        if (open) {
          await failPendingRegistration(
            tx,
            open.id,
            SavedCardFailureReason.SUPERSEDED,
            now,
          );
        }
        const row = await tx.savedPaymentMethod.create({
          data: {
            userId: user.id,
            provider: PaymentProvider.PAYHERE,
            status: SavedCardStatus.PENDING,
            merchantReference,
            consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
            consentedAt: now,
            authorizationEnabled: false,
            openCardSlot: user.id,
          },
        });
        await tx.savedCardConsentEvent.create({
          data: {
            userId: user.id,
            savedPaymentMethodId: row.id,
            type: SavedCardConsentEventType.CONSENT_GRANTED,
            consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
          },
        });
        return row;
      });
    } catch (error) {
      // Only a truly concurrent start for the same customer lands here.
      if (!isUniqueConflict(error)) throw error;
      throw new ConflictException('A card registration is already in progress');
    }
    if (open) {
      this.logger.log({
        event: 'payhere.preapproval.superseded',
        savedCardId: open.id,
        merchantReference: open.merchantReference,
        outcome: 'failed',
        failureReason: SavedCardFailureReason.SUPERSEDED,
      });
    }

    const form = this.payhere.createPreapproval({
      merchantReference,
      customer: {
        firstName: billing.firstName!,
        lastName: billing.lastName!,
        email: billing.email!,
        phone: billing.phone,
        address: billing.address!,
        city: billing.city!,
        country: billing.country!,
      },
    });
    return {
      savedCardId: created.id,
      consentVersion: AUTOMATIC_PAYMENT_CONSENT_VERSION,
      preapproval: form,
    };
  }

  /**
   * Ends one registration flow. The app calls this when the PayHere page
   * closes (return URL, cancel URL, or the customer closing the WebView).
   *
   * The browser return is not proof of success: PayHere passes no status to
   * return_url, and only the signed notify carries `customer_token`. So the
   * card is ACTIVE only if handleNotify already activated it. Otherwise this
   * waits briefly for that notify, then marks the attempt FAILED and releases
   * openCardSlot so the customer can retry immediately. It never returns
   * PENDING.
   */
  async complete(
    userId: string,
    id: string,
    clientOutcome: RegistrationClientOutcome | undefined,
  ): Promise<RegistrationResult> {
    let row = await this.owned(userId, id);
    if (
      row.status === SavedCardStatus.PENDING &&
      clientOutcome !== 'CANCELLED'
    ) {
      row = await this.awaitNotify(row);
    }
    if (row.status !== SavedCardStatus.PENDING) {
      return toRegistrationResult(row);
    }
    const reason =
      clientOutcome === 'CANCELLED'
        ? SavedCardFailureReason.CUSTOMER_CANCELLED
        : SavedCardFailureReason.NOT_CONFIRMED;
    const failed = await failPendingRegistration(
      this.prisma,
      row.id,
      reason,
      new Date(),
    );
    if (failed) {
      this.logger.log({
        event: 'payhere.preapproval.completed_unconfirmed',
        savedCardId: row.id,
        merchantReference: row.merchantReference,
        clientOutcome: clientOutcome ?? null,
        outcome: 'failed',
        failureReason: reason,
      });
    }
    // If the notify won the race, this row is ACTIVE (or FAILED by PayHere).
    return toRegistrationResult(await this.owned(userId, id));
  }

  /**
   * Expiry-sweep backstop: fail registrations whose app never completed the
   * flow. Status-guarded and idempotent.
   */
  async failAbandonedRegistrations(now: Date = new Date()) {
    const cutoff = new Date(
      now.getTime() - ABANDONED_REGISTRATION_MINUTES * 60_000,
    );
    return failStalePendingRegistrations(this.prisma, {
      createdBefore: cutoff,
      reason: SavedCardFailureReason.ABANDONED,
      now,
    });
  }

  private async awaitNotify(row: SavedPaymentMethod) {
    const { totalMs, intervalMs } = this.completionWait;
    let waited = 0;
    let current = row;
    while (current.status === SavedCardStatus.PENDING && waited < totalMs) {
      const step = Math.max(1, Math.min(intervalMs, totalMs - waited));
      await this.sleep(step);
      waited += step;
      current = await this.owned(row.userId, row.id);
    }
    return current;
  }

  async handleNotify(fields: Record<string, string>) {
    if (!this.payhere) {
      throw new NotFoundException('PayHere notifications are not enabled');
    }
    const receivedAt = new Date().toISOString();
    const hintedReference =
      typeof fields.order_id === 'string' && fields.order_id.length > 0
        ? fields.order_id
        : null;
    this.logger.log({
      event: 'payhere.preapproval.notify.received',
      receivedAt,
      merchantReference: hintedReference,
    });
    let parsed: ReturnType<PreapprovalClient['verifyPreapproval']>;
    try {
      parsed = this.payhere.verifyPreapproval(fields);
    } catch (error) {
      const category =
        error instanceof PayHereNotificationError
          ? payHereErrorCategory(error)
          : 'malformed';
      this.logger.warn({
        event:
          category === 'invalid_signature'
            ? 'payhere.preapproval.notify.invalid_signature'
            : 'payhere.preapproval.notify.rejected',
        receivedAt,
        merchantReference: hintedReference,
        signatureValid: category === 'invalid_signature' ? false : null,
        outcome: 'rejected',
        errorCategory: category,
        errorName: payHereErrorName(error),
      });
      if (error instanceof PayHereNotificationError) {
        throw new BadRequestException('Invalid PayHere notification');
      }
      throw new BadRequestException('Malformed PayHere notification');
    }
    const row = await this.prisma.savedPaymentMethod.findUnique({
      where: { merchantReference: parsed.merchantReference },
    });
    if (!row) {
      this.logger.warn({
        event: 'payhere.preapproval.notify.unknown_reference',
        receivedAt,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        statusCode: parsed.statusCode,
        outcome: 'unknown_reference',
      });
      throw new NotFoundException('Saved card registration not found');
    }
    if (
      row.status === SavedCardStatus.FAILED &&
      parsed.success &&
      parsed.customerToken
    ) {
      return this.recordLateAuthorization(row, parsed, receivedAt);
    }
    if (row.status !== SavedCardStatus.PENDING) {
      this.logger.log({
        event: 'payhere.preapproval.notify.duplicate',
        receivedAt,
        savedCardId: row.id,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        statusCode: parsed.statusCode,
        outcome: 'duplicate',
        savedCardStatus: row.status,
      });
      return { alreadyHandled: true, savedCard: toView(row) };
    }
    try {
      if (parsed.outcome === 'pending' || !parsed.success) {
        if (parsed.outcome === 'pending') {
          this.logger.log({
            event: 'payhere.preapproval.notify.pending',
            receivedAt,
            savedCardId: row.id,
            merchantReference: parsed.merchantReference,
            signatureValid: true,
            statusCode: parsed.statusCode,
            outcome: 'pending',
          });
          return { pending: true, savedCard: toView(row) };
        }
        await failPendingRegistration(
          this.prisma,
          row.id,
          parsed.statusCode === -1
            ? SavedCardFailureReason.PAYHERE_CANCELLED
            : SavedCardFailureReason.PAYHERE_DECLINED,
          new Date(),
          { payherePaymentId: parsed.providerPaymentId || null },
        );
        this.logger.log({
          event: 'payhere.preapproval.notify.failed',
          receivedAt,
          savedCardId: row.id,
          merchantReference: parsed.merchantReference,
          signatureValid: true,
          statusCode: parsed.statusCode,
          outcome: 'failed',
        });
        return { failed: true };
      }
      if (!parsed.customerToken) {
        this.logger.log({
          event: 'payhere.preapproval.notify.pending',
          receivedAt,
          savedCardId: row.id,
          merchantReference: parsed.merchantReference,
          signatureValid: true,
          statusCode: parsed.statusCode,
          outcome: 'pending_missing_token',
        });
        return { pending: true, savedCard: toView(row) };
      }
      const encrypted = this.crypto.encryptOpaque(parsed.customerToken);
      const activated = await this.prisma.$transaction((tx) =>
        tx.savedPaymentMethod.updateMany({
          where: { id: row.id, status: SavedCardStatus.PENDING },
          data: {
            status: SavedCardStatus.ACTIVE,
            authorizationEnabled: true,
            tokenCiphertext: encrypted.ciphertext,
            tokenIv: encrypted.iv,
            tokenTag: encrypted.tag,
            openCardSlot: null,
            payherePaymentId: parsed.providerPaymentId || null,
            cardBrand: parsed.cardBrand,
            cardLast4: parsed.cardLast4,
          },
        }),
      );
      if (activated.count === 0) {
        const current = await this.prisma.savedPaymentMethod.findUniqueOrThrow({
          where: { id: row.id },
        });
        if (current.status === SavedCardStatus.FAILED) {
          // `complete`, a newer start, or the sweep failed it first.
          return this.recordLateAuthorization(current, parsed, receivedAt);
        }
        this.logger.log({
          event: 'payhere.preapproval.notify.duplicate',
          receivedAt,
          savedCardId: current.id,
          merchantReference: parsed.merchantReference,
          signatureValid: true,
          statusCode: parsed.statusCode,
          outcome: 'duplicate',
          savedCardStatus: current.status,
        });
        return { alreadyHandled: true, savedCard: toView(current) };
      }
      this.logger.log({
        event: 'payhere.preapproval.notify.activated',
        receivedAt,
        savedCardId: row.id,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        statusCode: parsed.statusCode,
        outcome: 'activated',
        hasProviderPaymentId: Boolean(parsed.providerPaymentId),
      });
      return {
        active: true,
        savedCard: toView({
          ...row,
          status: SavedCardStatus.ACTIVE,
          authorizationEnabled: true,
          cardBrand: parsed.cardBrand,
          cardLast4: parsed.cardLast4,
        }),
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      this.logger.error({
        event: 'payhere.preapproval.notify.exception',
        receivedAt,
        savedCardId: row.id,
        merchantReference: parsed.merchantReference,
        signatureValid: true,
        statusCode: parsed.statusCode,
        outcome: 'exception',
        errorCategory: payHereErrorCategory(error),
        errorName: payHereErrorName(error),
      });
      throw error;
    }
  }

  /**
   * A verified PayHere success for a registration that is already FAILED.
   * The card is never reactivated and the token is never stored, so it can
   * never be charged. PayHere has no API to cancel a pre-approval, so the
   * row is flagged (lateAuthorizationAt) for manual cancellation in the
   * PayHere merchant portal. Idempotent: only the first notify sets the flag.
   * Returns normally (HTTP 200) so PayHere stops retrying.
   */
  private async recordLateAuthorization(
    row: SavedPaymentMethod,
    parsed: ReturnType<PreapprovalClient['verifyPreapproval']>,
    receivedAt: string,
  ) {
    const flagged = await this.prisma.savedPaymentMethod.updateMany({
      where: {
        id: row.id,
        status: SavedCardStatus.FAILED,
        lateAuthorizationAt: null,
      },
      data: {
        lateAuthorizationAt: new Date(),
        payherePaymentId:
          row.payherePaymentId ?? (parsed.providerPaymentId || null),
      },
    });
    const first = flagged.count === 1;
    const entry = {
      event: first
        ? 'payhere.preapproval.notify.late_authorization'
        : 'payhere.preapproval.notify.duplicate',
      receivedAt,
      savedCardId: row.id,
      merchantReference: parsed.merchantReference,
      signatureValid: true,
      statusCode: parsed.statusCode,
      outcome: first ? 'late_authorization' : 'duplicate',
      savedCardStatus: SavedCardStatus.FAILED,
      failureReason: row.failureReason,
      action: first ? 'cancel_preapproval_in_payhere_merchant_portal' : null,
    };
    if (first) this.logger.error(entry);
    else this.logger.log(entry);
    return { alreadyHandled: true, lateAuthorization: true };
  }

  async revoke(userId: string, id: string) {
    const row = await this.owned(userId, id);
    if (
      row.status === SavedCardStatus.DISABLED ||
      row.status === SavedCardStatus.REMOVED ||
      row.status === SavedCardStatus.FAILED
    ) {
      return toView(row);
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockSavedCard(tx, id, userId);
      const updated = await tx.savedPaymentMethod.updateMany({
        where: {
          id,
          userId,
          status: { in: [SavedCardStatus.PENDING, SavedCardStatus.ACTIVE] },
        },
        data: {
          status: SavedCardStatus.DISABLED,
          revokedAt: now,
          ...RETIRED,
        },
      });
      if (updated.count === 1) {
        await tx.savedCardConsentEvent.create({
          data: {
            userId,
            savedPaymentMethodId: id,
            type: SavedCardConsentEventType.CONSENT_REVOKED,
            consentVersion: row.consentVersion,
          },
        });
      }
    });
    return toView(await this.owned(userId, id));
  }

  async remove(userId: string, id: string) {
    const row = await this.owned(userId, id);
    if (row.status === SavedCardStatus.REMOVED) return toView(row);
    const now = new Date();
    const alreadyRevoked =
      row.status === SavedCardStatus.DISABLED || row.revokedAt !== null;
    await this.prisma.$transaction(async (tx) => {
      await lockSavedCard(tx, id, userId);
      const updated = await tx.savedPaymentMethod.updateMany({
        where: { id, userId, status: { not: SavedCardStatus.REMOVED } },
        data: {
          status: SavedCardStatus.REMOVED,
          revokedAt: row.revokedAt ?? now,
          removedAt: now,
          ...RETIRED,
        },
      });
      if (updated.count !== 1) return;
      if (!alreadyRevoked && row.status !== SavedCardStatus.FAILED) {
        await tx.savedCardConsentEvent.create({
          data: {
            userId,
            savedPaymentMethodId: id,
            type: SavedCardConsentEventType.CONSENT_REVOKED,
            consentVersion: row.consentVersion,
          },
        });
      }
      await tx.savedCardConsentEvent.create({
        data: {
          userId,
          savedPaymentMethodId: id,
          type: SavedCardConsentEventType.CARD_REMOVED,
          consentVersion: row.consentVersion,
        },
      });
    });
    return toView(await this.owned(userId, id));
  }

  /**
   * Next-phase charging can call this. It decrypts only an ACTIVE card whose
   * authorization is still on and whose token columns are present.
   */
  async readActiveToken(userId: string, id: string): Promise<string> {
    const row = await this.owned(userId, id);
    if (!savedCardIsChargeable(row)) {
      throw new ConflictException(
        'Saved card is not authorized for automatic payment',
      );
    }
    return this.crypto.decryptOpaque({
      ciphertext: row.tokenCiphertext!,
      iv: row.tokenIv!,
      tag: row.tokenTag!,
    });
  }

  private async owned(userId: string, id: string) {
    const row = await this.prisma.savedPaymentMethod.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Saved card not found');
    return row;
  }
}

export function savedCardIsChargeable(row: {
  status: SavedCardStatus;
  authorizationEnabled: boolean;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  revokedAt: Date | null;
  removedAt: Date | null;
}): boolean {
  return (
    row.status === SavedCardStatus.ACTIVE &&
    row.authorizationEnabled &&
    row.revokedAt === null &&
    row.removedAt === null &&
    Boolean(row.tokenCiphertext && row.tokenIv && row.tokenTag)
  );
}

function toFailedRegistration(row: SavedPaymentMethod): FailedRegistrationView {
  return {
    id: row.id,
    status: SavedCardStatus.FAILED,
    reason: customerFailureReason(row.failureReason),
    consentedAt: row.consentedAt,
    failedAt: row.failedAt,
  };
}

function customerFailureReason(
  reason: SavedCardFailureReason | null,
): FailedRegistrationReason {
  switch (reason) {
    case SavedCardFailureReason.PAYHERE_DECLINED:
      return 'DECLINED';
    case SavedCardFailureReason.PAYHERE_CANCELLED:
    case SavedCardFailureReason.CUSTOMER_CANCELLED:
      return 'CANCELLED';
    default:
      return 'NOT_CONFIRMED';
  }
}

function toRegistrationResult(row: SavedPaymentMethod): RegistrationResult {
  if (row.status === SavedCardStatus.FAILED) {
    return {
      status: row.status,
      savedCard: null,
      failedRegistration: toFailedRegistration(row),
    };
  }
  return {
    status: row.status,
    savedCard: toView(row),
    failedRegistration: null,
  };
}

type SavedCardWriter = Pick<Prisma.TransactionClient, 'savedPaymentMethod'>;

/**
 * PENDING -> FAILED, releasing openCardSlot. Status-guarded, so it never
 * touches an ACTIVE card or an attempt that already ended. Returns whether
 * this call made the transition.
 */
async function failPendingRegistration(
  db: SavedCardWriter,
  id: string,
  reason: SavedCardFailureReason,
  now: Date,
  extra: Prisma.SavedPaymentMethodUpdateManyMutationInput = {},
): Promise<boolean> {
  const updated = await db.savedPaymentMethod.updateMany({
    where: { id, status: SavedCardStatus.PENDING },
    data: {
      ...extra,
      status: SavedCardStatus.FAILED,
      failureReason: reason,
      failedAt: now,
      ...RETIRED,
    },
  });
  return updated.count === 1;
}

/**
 * Fails every PENDING registration created before `createdBefore` (optionally
 * only the given ids). Used by the expiry-sweep backstop and the one-off
 * legacy cleanup script. Rows and consent events are kept.
 */
export async function failStalePendingRegistrations(
  db: SavedCardWriter,
  input: {
    createdBefore: Date;
    reason: SavedCardFailureReason;
    now: Date;
    ids?: string[];
  },
): Promise<{ failed: number }> {
  const updated = await db.savedPaymentMethod.updateMany({
    where: {
      status: SavedCardStatus.PENDING,
      createdAt: { lt: input.createdBefore },
      ...(input.ids ? { id: { in: input.ids } } : {}),
    },
    data: {
      status: SavedCardStatus.FAILED,
      failureReason: input.reason,
      failedAt: input.now,
      ...RETIRED,
    },
  });
  return { failed: updated.count };
}

function toView(row: SavedPaymentMethod): SavedCardView {
  return {
    id: row.id,
    status: row.status,
    authorizationEnabled: row.authorizationEnabled,
    cardBrand: row.cardBrand,
    cardLast4: row.cardLast4,
    consentVersion: row.consentVersion,
    consentedAt: row.consentedAt,
    revokedAt: row.revokedAt,
    removedAt: row.removedAt,
  };
}

async function lockSavedCard(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
) {
  await tx.$queryRaw`
    SELECT \`id\`
    FROM \`SavedPaymentMethod\`
    WHERE \`id\` = ${id} AND \`userId\` = ${userId}
    FOR UPDATE
  `;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

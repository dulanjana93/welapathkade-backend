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

/** Customer-visible in-flight registration. No card or token fields. */
export type PendingRegistrationView = {
  id: string;
  status: typeof SavedCardStatus.PENDING;
  consentedAt: Date;
};

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
    const [rows, pending] = await Promise.all([
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
      this.prisma.savedPaymentMethod.findFirst({
        where: { userId, status: SavedCardStatus.PENDING },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      consent: this.consent(),
      methods: rows.map(toView),
      pendingRegistration: pending ? toPendingRegistration(pending) : null,
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
    const existing = await this.prisma.savedPaymentMethod.findFirst({
      where: { openCardSlot: user.id },
    });
    if (existing) {
      throw new ConflictException('A card registration is already in progress');
    }

    const now = new Date();
    const merchantReference = `pa_${randomBytes(12).toString('hex')}`;
    let created: SavedPaymentMethod;
    try {
      created = await this.prisma.$transaction(async (tx) => {
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
      if (!isUniqueConflict(error)) throw error;
      throw new ConflictException('A card registration is already in progress');
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
        await this.prisma.$transaction((tx) =>
          tx.savedPaymentMethod.updateMany({
            where: { id: row.id, status: SavedCardStatus.PENDING },
            data: {
              status: SavedCardStatus.FAILED,
              authorizationEnabled: false,
              openCardSlot: null,
              payherePaymentId: parsed.providerPaymentId || null,
            },
          }),
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

function toPendingRegistration(row: SavedPaymentMethod): PendingRegistrationView {
  return {
    id: row.id,
    status: SavedCardStatus.PENDING,
    consentedAt: row.consentedAt,
  };
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

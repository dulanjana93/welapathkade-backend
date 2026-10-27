import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LedgerCategory,
  LedgerEntryKind,
  Prisma,
  WithdrawalEventAction,
  WithdrawalPurpose,
  WithdrawalStatus,
  type User,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { toMoneyString } from '../common/money/money';
import { PrismaService } from '../prisma/prisma.service';
import {
  hasDateBound,
  parseUtcHalfOpenRange,
  prismaDateTimeFilter,
} from '../admin/admin-finance.date';
import { roundMoney } from '../settlement/settlement-allocation';
import { ZERO_MONEY } from '../settlement/settlement.constants';
import { BankAccountCrypto, maskAccountNumber } from './bank-account.crypto';
import type {
  AdminWithdrawalQueryDto,
  CancelWithdrawalDto,
  CreateBankAccountDto,
  CreateWithdrawalDto,
  MarkWithdrawalPaidDto,
  RejectWithdrawalDto,
  UpdateBankAccountDto,
  WithdrawalListQueryDto,
} from './dto/withdrawal.dto';
import {
  MIN_WITHDRAWAL_AMOUNT,
  RESERVED_WITHDRAWAL_STATUSES,
  WITHDRAWAL_CURRENCY,
} from './withdrawals.constants';
import {
  assertWithdrawalCurrency,
  computeWithdrawableAmounts,
  parseWithdrawalAmount,
} from './withdrawals.money';

type Tx = Prisma.TransactionClient;

const bankPublicSelect = {
  id: true,
  bankName: true,
  accountHolderName: true,
  branchName: true,
  bankCode: true,
  branchCode: true,
  accountNumberLast4: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AstrologerBankAccountSelect;

const withdrawalPublicSelect = {
  id: true,
  amount: true,
  currency: true,
  status: true,
  purpose: true,
  createdAt: true,
  destinationBankName: true,
  destinationAccountHolderName: true,
  destinationBranchName: true,
  destinationBankCode: true,
  destinationBranchCode: true,
  destinationAccountLast4: true,
  approvedAt: true,
  rejectedAt: true,
  rejectionReason: true,
  cancelledAt: true,
  cancellationReason: true,
  paidAt: true,
  transferReference: true,
  actualTransferredAt: true,
} satisfies Prisma.WithdrawalRequestSelect;

type BankPublic = Prisma.AstrologerBankAccountGetPayload<{
  select: typeof bankPublicSelect;
}>;

type WithdrawalPublic = Prisma.WithdrawalRequestGetPayload<{
  select: typeof withdrawalPublicSelect;
}>;

@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: BankAccountCrypto,
    private readonly audit: AuditService,
  ) {}

  async createBankAccount(user: User, dto: CreateBankAccountDto) {
    const encrypted = this.crypto.encrypt(dto.accountNumber);
    const row = await this.prisma.astrologerBankAccount.create({
      data: {
        userId: user.id,
        bankName: dto.bankName.trim(),
        accountHolderName: dto.accountHolderName.trim(),
        branchName: dto.branchName.trim(),
        bankCode: dto.bankCode?.trim() ?? null,
        branchCode: dto.branchCode?.trim() ?? null,
        accountNumberLast4: encrypted.last4,
        accountNumberCiphertext: encrypted.ciphertext,
        accountNumberIv: encrypted.iv,
        accountNumberTag: encrypted.tag,
      },
      select: bankPublicSelect,
    });
    return this.toBank(row);
  }

  async listBankAccounts(user: User) {
    const rows = await this.prisma.astrologerBankAccount.findMany({
      where: { userId: user.id },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      select: bankPublicSelect,
    });
    return rows.map((row) => this.toBank(row));
  }

  async updateBankAccount(user: User, id: string, dto: UpdateBankAccountDto) {
    const hasChange = Object.values(dto).some((value) => value !== undefined);
    if (!hasChange) {
      throw new BadRequestException('BANK_ACCOUNT_NO_CHANGES');
    }
    const existing = await this.prisma.astrologerBankAccount.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('BANK_ACCOUNT_NOT_FOUND');
    }
    const encrypted = dto.accountNumber
      ? this.crypto.encrypt(dto.accountNumber)
      : null;
    const row = await this.prisma.astrologerBankAccount.update({
      where: { id },
      data: {
        bankName: dto.bankName?.trim(),
        accountHolderName: dto.accountHolderName?.trim(),
        branchName: dto.branchName?.trim(),
        bankCode: dto.bankCode === undefined ? undefined : dto.bankCode.trim(),
        branchCode:
          dto.branchCode === undefined ? undefined : dto.branchCode.trim(),
        isActive: dto.isActive,
        ...(encrypted
          ? {
              accountNumberLast4: encrypted.last4,
              accountNumberCiphertext: encrypted.ciphertext,
              accountNumberIv: encrypted.iv,
              accountNumberTag: encrypted.tag,
            }
          : {}),
      },
      select: bankPublicSelect,
    });
    return this.toBank(row);
  }

  async summary(user: User) {
    return this.summaryFor(user, WithdrawalPurpose.ASTROLOGER_EARNINGS);
  }

  async referralPayoutSummary(user: User) {
    return this.summaryFor(user, WithdrawalPurpose.CUSTOMER_REFERRAL);
  }

  private async summaryFor(user: User, purpose: WithdrawalPurpose) {
    const snapshot = await this.readFunds(this.prisma, user.id, purpose);
    const [pending, approved, paid, activeAccounts] = await Promise.all([
      this.sumStatus(user.id, WithdrawalStatus.PENDING_REVIEW, purpose),
      this.sumStatus(user.id, WithdrawalStatus.APPROVED, purpose),
      this.sumStatus(user.id, WithdrawalStatus.PAID, purpose),
      this.prisma.astrologerBankAccount.count({
        where: { userId: user.id, isActive: true },
      }),
    ]);
    const hasActiveBankAccount = activeAccounts > 0;
    const belowMinimum = snapshot.withdrawable.lessThan(MIN_WITHDRAWAL_AMOUNT);
    const customer = purpose === WithdrawalPurpose.CUSTOMER_REFERRAL;
    return {
      currency: snapshot.currency,
      availableBalance: toMoneyString(snapshot.walletAvailable),
      eligibleAmount: toMoneyString(snapshot.eligibleRemaining),
      reservedAmount: toMoneyString(snapshot.reserved),
      withdrawableAmount: toMoneyString(snapshot.withdrawable),
      minimumAmount: toMoneyString(MIN_WITHDRAWAL_AMOUNT),
      hasActiveBankAccount,
      canRequest: hasActiveBankAccount && !belowMinimum,
      blockedReason: !hasActiveBankAccount
        ? 'NO_BANK_ACCOUNT'
        : belowMinimum
          ? 'BELOW_MINIMUM'
          : null,
      pendingReview: pending,
      approvedUnpaid: approved,
      paid,
      purpose,
      notes: customer
        ? {
            availableIsInternalWalletNotPayout: true,
            reservedIsNotTransferred: true,
            approvalIsNotPayment: true,
            onlyCustomerReferralEligible: true,
            astrologerEarningExcluded: true,
            astrologerReferralExcluded: true,
            platformResidualExcluded: true,
            formula:
              'withdrawable = min(wallet, max(0, CUSTOMER_REFERRAL net − paid customer payout debits)) − active customer payout reservations',
          }
        : {
            availableIsInternalWalletNotPayout: true,
            reservedIsNotTransferred: true,
            approvalIsNotPayment: true,
            customerReferralExcluded: true,
            platformResidualExcluded: true,
            astrologerReferralIncluded: true,
          },
    };
  }

  async createWithdrawal(
    user: User,
    dto: CreateWithdrawalDto,
    idempotencyKey: string | null,
    purpose: WithdrawalPurpose = WithdrawalPurpose.ASTROLOGER_EARNINGS,
  ) {
    const amount = parseWithdrawalAmount(dto.amount);
    const currency = assertWithdrawalCurrency(dto.currency);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const wallet = await this.lockWallet(tx, user.id);
        if (idempotencyKey) {
          const replay = await this.replayIdempotent(
            tx,
            user.id,
            idempotencyKey,
            amount,
            dto.bankAccountId,
            purpose,
          );
          if (replay) {
            return this.attachBalances(tx, user.id, purpose, replay);
          }
        }

        const account = await tx.astrologerBankAccount.findFirst({
          where: { id: dto.bankAccountId, userId: user.id },
        });
        if (!account) {
          throw new BadRequestException('BANK_ACCOUNT_REQUIRED');
        }
        if (!account.isActive) {
          throw new BadRequestException('BANK_ACCOUNT_INACTIVE');
        }

        const funds = await this.fundsFromLockedWallet(
          tx,
          user.id,
          wallet,
          purpose,
        );
        if (amount.greaterThan(funds.withdrawable)) {
          throw new BadRequestException('WITHDRAWAL_INSUFFICIENT_FUNDS');
        }

        const created = await tx.withdrawalRequest.create({
          data: {
            userId: user.id,
            bankAccountId: account.id,
            amount,
            currency,
            status: WithdrawalStatus.PENDING_REVIEW,
            purpose,
            clientIdempotencyKey: idempotencyKey,
            destinationBankName: account.bankName,
            destinationAccountHolderName: account.accountHolderName,
            destinationBranchName: account.branchName,
            destinationBankCode: account.bankCode,
            destinationBranchCode: account.branchCode,
            destinationAccountLast4: account.accountNumberLast4,
            destinationAccountCiphertext: account.accountNumberCiphertext,
            destinationAccountIv: account.accountNumberIv,
            destinationAccountTag: account.accountNumberTag,
          },
          select: withdrawalPublicSelect,
        });
        await tx.withdrawalEvent.create({
          data: {
            withdrawalId: created.id,
            actorUserId: user.id,
            action: WithdrawalEventAction.CREATED,
            metadata: {
              amount: toMoneyString(amount),
              currency,
              fromStatus: null,
              toStatus: WithdrawalStatus.PENDING_REVIEW,
            },
          },
        });
        return this.attachBalances(
          tx,
          user.id,
          purpose,
          this.toWithdrawal(created),
        );
      });
    } catch (error) {
      if (
        idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.withdrawalRequest.findUnique({
          where: {
            userId_clientIdempotencyKey: {
              userId: user.id,
              clientIdempotencyKey: idempotencyKey,
            },
          },
          select: withdrawalPublicSelect,
        });
        if (
          existing &&
          existing.amount.equals(amount) &&
          (await this.sameBankAccount(user.id, existing.id, dto.bankAccountId))
        ) {
          return this.attachBalances(
            this.prisma,
            user.id,
            purpose,
            this.toWithdrawal(existing),
          );
        }
        throw new ConflictException('IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  }

  async listMine(
    user: User,
    query: WithdrawalListQueryDto,
    purpose: WithdrawalPurpose = WithdrawalPurpose.ASTROLOGER_EARNINGS,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.WithdrawalRequestWhereInput = {
      userId: user.id,
      purpose,
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.withdrawalRequest.count({ where }),
      this.prisma.withdrawalRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: withdrawalPublicSelect,
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => this.toWithdrawal(row)),
    };
  }

  async getMine(
    user: User,
    id: string,
    purpose: WithdrawalPurpose = WithdrawalPurpose.ASTROLOGER_EARNINGS,
  ) {
    const row = await this.prisma.withdrawalRequest.findFirst({
      where: { id, userId: user.id, purpose },
      select: withdrawalPublicSelect,
    });
    if (!row) throw new NotFoundException('WITHDRAWAL_NOT_FOUND');
    return this.toWithdrawal(row);
  }

  async listAdmin(query: AdminWithdrawalQueryDto) {
    const range = parseUtcHalfOpenRange(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const purpose = query.purpose ?? WithdrawalPurpose.ASTROLOGER_EARNINGS;
    const where: Prisma.WithdrawalRequestWhereInput = {
      purpose,
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(hasDateBound(range)
        ? { createdAt: prismaDateTimeFilter(range) }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.withdrawalRequest.count({ where }),
      this.prisma.withdrawalRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          ...withdrawalPublicSelect,
          userId: true,
          user: { select: { id: true, name: true } },
        },
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        ...this.toWithdrawal(row),
        userId: row.userId,
        ...this.beneficiaryFields(row.purpose, row.user.name),
      })),
    };
  }

  async getAdmin(id: string) {
    const row = await this.prisma.withdrawalRequest.findUnique({
      where: { id },
      select: {
        ...withdrawalPublicSelect,
        userId: true,
        bankAccountId: true,
        user: { select: { id: true, name: true } },
        events: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            action: true,
            actorUserId: true,
            reason: true,
            createdAt: true,
          },
        },
        debit: {
          select: { id: true, amount: true, currency: true, createdAt: true },
        },
      },
    });
    if (!row) throw new NotFoundException('WITHDRAWAL_NOT_FOUND');
    const funds = await this.readFunds(this.prisma, row.userId, row.purpose);
    const gap = funds.reserved.minus(funds.walletAvailable);
    const shortfall = gap.greaterThan(ZERO_MONEY) ? gap : ZERO_MONEY;
    return {
      ...this.toWithdrawal(row),
      funds: {
        availableBalance: toMoneyString(funds.walletAvailable),
        reservedAmount: toMoneyString(funds.reserved),
        shortfallAmount: toMoneyString(shortfall),
      },
      userId: row.userId,
      ...this.beneficiaryFields(row.purpose, row.user.name),
      bankAccountId: row.bankAccountId,
      debit: row.debit
        ? {
            id: row.debit.id,
            amount: toMoneyString(row.debit.amount),
            currency: row.debit.currency,
            createdAt: row.debit.createdAt.toISOString(),
          }
        : null,
      events: row.events.map((event) => ({
        id: event.id,
        action: event.action,
        actorUserId: event.actorUserId,
        reason: event.reason,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async approve(admin: User, id: string, ip?: string | null) {
    return this.transition(admin, id, ip, {
      from: WithdrawalStatus.PENDING_REVIEW,
      to: WithdrawalStatus.APPROVED,
      action: WithdrawalEventAction.APPROVED,
      auditAction: 'WITHDRAWAL_APPROVED',
      data: {
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: { connect: { id: admin.id } },
      },
    });
  }

  async reject(
    admin: User,
    id: string,
    dto: RejectWithdrawalDto,
    ip?: string | null,
  ) {
    const reason = dto.reason.trim();
    if (reason.length < 3) {
      throw new BadRequestException('WITHDRAWAL_REJECTION_REASON_REQUIRED');
    }
    return this.transition(admin, id, ip, {
      from: WithdrawalStatus.PENDING_REVIEW,
      to: WithdrawalStatus.REJECTED,
      action: WithdrawalEventAction.REJECTED,
      auditAction: 'WITHDRAWAL_REJECTED',
      reason,
      data: {
        status: WithdrawalStatus.REJECTED,
        rejectedAt: new Date(),
        rejectedBy: { connect: { id: admin.id } },
        rejectionReason: reason,
      },
    });
  }

  async cancel(
    admin: User,
    id: string,
    dto: CancelWithdrawalDto,
    ip?: string | null,
  ) {
    const reason = dto.reason.trim();
    if (reason.length < 3) {
      throw new BadRequestException('WITHDRAWAL_CANCELLATION_REASON_REQUIRED');
    }
    return this.transition(admin, id, ip, {
      from: WithdrawalStatus.APPROVED,
      to: WithdrawalStatus.CANCELLED,
      action: WithdrawalEventAction.CANCELLED,
      auditAction: 'WITHDRAWAL_CANCELLED',
      reason,
      data: {
        status: WithdrawalStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: { connect: { id: admin.id } },
        cancellationReason: reason,
      },
    });
  }

  async markPaid(
    admin: User,
    id: string,
    dto: MarkWithdrawalPaidDto,
    ip?: string | null,
  ) {
    const transferredAt = new Date(dto.actualTransferredAt);
    if (Number.isNaN(transferredAt.getTime())) {
      throw new BadRequestException('WITHDRAWAL_INVALID_TRANSFER_TIME');
    }
    const latest = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (transferredAt.getTime() > latest.getTime()) {
      throw new BadRequestException('WITHDRAWAL_INVALID_TRANSFER_TIME');
    }
    const reference = dto.transferReference.trim();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.withdrawalRequest.findUnique({
          where: { id },
          select: {
            id: true,
            userId: true,
            amount: true,
            currency: true,
            status: true,
            purpose: true,
          },
        });
        if (!current) throw new NotFoundException('WITHDRAWAL_NOT_FOUND');
        const wallet = await this.lockWallet(tx, current.userId);
        await this.lockWithdrawal(tx, id);
        const locked = await tx.withdrawalRequest.findUnique({
          where: { id },
          select: {
            id: true,
            userId: true,
            amount: true,
            currency: true,
            status: true,
            purpose: true,
          },
        });
        if (!locked || locked.status !== WithdrawalStatus.APPROVED) {
          throw new ConflictException('WITHDRAWAL_INVALID_STATE');
        }
        if (
          !wallet ||
          wallet.currency !== locked.currency ||
          roundMoney(wallet.availableBalance).lessThan(
            roundMoney(locked.amount),
          )
        ) {
          throw new ConflictException('WITHDRAWAL_WALLET_SHORTFALL');
        }
        const funds = await this.fundsFromLockedWallet(
          tx,
          locked.userId,
          wallet,
          locked.purpose,
        );
        if (funds.eligibleRemaining.lessThan(roundMoney(locked.amount))) {
          throw new ConflictException('WITHDRAWAL_ELIGIBLE_SHORTFALL');
        }

        // Claim PAID before the debit so a concurrent admin loses the row
        // before any financial write. The unique debit key is the backstop.
        const claimed = await tx.withdrawalRequest.updateMany({
          where: { id, status: WithdrawalStatus.APPROVED },
          data: {
            status: WithdrawalStatus.PAID,
            paidAt: new Date(),
            transferRecordedAt: new Date(),
            actualTransferredAt: transferredAt,
            transferReference: reference,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('WITHDRAWAL_INVALID_STATE');
        }
        await tx.withdrawalRequest.update({
          where: { id },
          data: { paidBy: { connect: { id: admin.id } } },
        });
        await tx.withdrawalDebit.create({
          data: {
            idempotencyKey: `withdrawal:${locked.id}:DEBIT`,
            withdrawalRequestId: locked.id,
            userId: locked.userId,
            amount: locked.amount,
            currency: locked.currency,
          },
        });
        await tx.walletAccount.update({
          where: { userId: locked.userId },
          data: { availableBalance: { decrement: locked.amount } },
        });
        await tx.withdrawalEvent.create({
          data: {
            withdrawalId: id,
            actorUserId: admin.id,
            action: WithdrawalEventAction.PAID,
            metadata: {
              amount: toMoneyString(locked.amount),
              currency: locked.currency,
              fromStatus: WithdrawalStatus.APPROVED,
              toStatus: WithdrawalStatus.PAID,
              transferReference: reference,
            },
          },
        });
        await this.audit.record(
          {
            adminUserId: admin.id,
            action: 'WITHDRAWAL_PAID',
            entityType: 'WithdrawalRequest',
            entityId: id,
            oldData: { status: WithdrawalStatus.APPROVED },
            newData: {
              status: WithdrawalStatus.PAID,
              amount: toMoneyString(locked.amount),
              currency: locked.currency,
              transferReference: reference,
            },
            ip: ip ?? null,
          },
          tx,
        );
        const row = await tx.withdrawalRequest.findUniqueOrThrow({
          where: { id },
          select: withdrawalPublicSelect,
        });
        return this.toWithdrawal(row);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = error.meta?.target;
        const targetText = Array.isArray(target)
          ? target.map((part) => String(part)).join(',')
          : typeof target === 'string'
            ? target
            : '';
        if (targetText.includes('transferReference')) {
          throw new ConflictException('TRANSFER_REFERENCE_TAKEN');
        }
        throw new ConflictException('WITHDRAWAL_ALREADY_PAID');
      }
      throw error;
    }
  }

  private async transition(
    admin: User,
    id: string,
    ip: string | null | undefined,
    change: {
      from: WithdrawalStatus;
      to: WithdrawalStatus;
      action: WithdrawalEventAction;
      auditAction: string;
      reason?: string;
      data: Prisma.WithdrawalRequestUpdateInput;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.withdrawalRequest.findUnique({
        where: { id },
        select: {
          id: true,
          userId: true,
          amount: true,
          currency: true,
          status: true,
        },
      });
      if (!current) throw new NotFoundException('WITHDRAWAL_NOT_FOUND');
      await this.lockWallet(tx, current.userId);
      await this.lockWithdrawal(tx, id);
      const locked = await tx.withdrawalRequest.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!locked || locked.status !== change.from) {
        throw new ConflictException('WITHDRAWAL_INVALID_STATE');
      }
      const claimed = await tx.withdrawalRequest.updateMany({
        where: { id, status: change.from },
        data: { status: change.to },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('WITHDRAWAL_INVALID_STATE');
      }
      await tx.withdrawalRequest.update({
        where: { id },
        data: change.data,
      });
      await tx.withdrawalEvent.create({
        data: {
          withdrawalId: id,
          actorUserId: admin.id,
          action: change.action,
          reason: change.reason ?? null,
          metadata: {
            amount: toMoneyString(current.amount),
            currency: current.currency,
            fromStatus: change.from,
            toStatus: change.to,
          },
        },
      });
      await this.audit.record(
        {
          adminUserId: admin.id,
          action: change.auditAction,
          entityType: 'WithdrawalRequest',
          entityId: id,
          oldData: { status: change.from },
          newData: {
            status: change.to,
            amount: toMoneyString(current.amount),
            currency: current.currency,
            ...(change.reason ? { reason: change.reason } : {}),
          },
          ip: ip ?? null,
        },
        tx,
      );
      const row = await tx.withdrawalRequest.findUniqueOrThrow({
        where: { id },
        select: withdrawalPublicSelect,
      });
      return this.toWithdrawal(row);
    });
  }

  private async readFunds(
    client: PrismaService | Tx,
    userId: string,
    purpose: WithdrawalPurpose,
  ) {
    const wallet = await client.walletAccount.findUnique({
      where: { userId },
    });
    return this.fundsFromLockedWallet(client, userId, wallet, purpose);
  }

  private async fundsFromLockedWallet(
    client: PrismaService | Tx,
    userId: string,
    wallet: { availableBalance: Prisma.Decimal; currency: string } | null,
    purpose: WithdrawalPurpose,
  ) {
    const categories =
      purpose === WithdrawalPurpose.CUSTOMER_REFERRAL
        ? [LedgerCategory.CUSTOMER_REFERRAL]
        : [
            LedgerCategory.ASTROLOGER_EARNING,
            LedgerCategory.ASTROLOGER_REFERRAL,
          ];
    const [groups, reservedAgg, paidAgg] = await Promise.all([
      client.ledgerEntry.groupBy({
        by: ['category', 'kind'],
        where: {
          userId,
          category: { in: categories },
        },
        _sum: { amount: true },
      }),
      client.withdrawalRequest.aggregate({
        where: {
          userId,
          purpose,
          status: { in: [...RESERVED_WITHDRAWAL_STATUSES] },
        },
        _sum: { amount: true },
      }),
      client.withdrawalDebit.aggregate({
        where: { userId, withdrawalRequest: { purpose } },
        _sum: { amount: true },
      }),
    ]);

    const net = (category: LedgerCategory) => {
      let credits = ZERO_MONEY;
      let debits = ZERO_MONEY;
      for (const row of groups) {
        if (row.category !== category) continue;
        const amount = row._sum.amount ?? ZERO_MONEY;
        if (row.kind === LedgerEntryKind.CREDIT) credits = credits.plus(amount);
        else debits = debits.plus(amount);
      }
      return credits.minus(debits);
    };

    const walletAvailable = wallet?.availableBalance ?? ZERO_MONEY;
    const reserved = reservedAgg._sum.amount ?? ZERO_MONEY;
    const paidWithdrawalDebits = paidAgg._sum.amount ?? ZERO_MONEY;
    const customer = purpose === WithdrawalPurpose.CUSTOMER_REFERRAL;
    const computed = computeWithdrawableAmounts({
      walletAvailable,
      earningNet: customer
        ? net(LedgerCategory.CUSTOMER_REFERRAL)
        : net(LedgerCategory.ASTROLOGER_EARNING),
      astrologerReferralNet: customer
        ? ZERO_MONEY
        : net(LedgerCategory.ASTROLOGER_REFERRAL),
      paidWithdrawalDebits,
      reserved,
    });
    return {
      currency: wallet?.currency ?? WITHDRAWAL_CURRENCY,
      walletAvailable: roundMoney(walletAvailable),
      reserved: roundMoney(reserved),
      eligibleRemaining: computed.eligibleRemaining,
      withdrawable: computed.withdrawable,
    };
  }

  private async sumStatus(
    userId: string,
    status: WithdrawalStatus,
    purpose: WithdrawalPurpose,
  ) {
    const agg = await this.prisma.withdrawalRequest.aggregate({
      where: { userId, status, purpose },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      count: agg._count._all,
      amount: toMoneyString(agg._sum.amount ?? ZERO_MONEY),
    };
  }

  private async lockWallet(tx: Tx, userId: string) {
    const rows = await tx.$queryRaw<
      Array<{ availableBalance: Prisma.Decimal; currency: string }>
    >`
      SELECT \`availableBalance\`, \`currency\`
      FROM \`WalletAccount\`
      WHERE \`userId\` = ${userId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      availableBalance: new Prisma.Decimal(row.availableBalance),
      currency: row.currency,
    };
  }

  private async lockWithdrawal(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`
      SELECT \`id\` FROM \`WithdrawalRequest\` WHERE \`id\` = ${id} FOR UPDATE
    `;
  }

  private async replayIdempotent(
    tx: Tx,
    userId: string,
    idempotencyKey: string,
    amount: Prisma.Decimal,
    bankAccountId: string,
    purpose: WithdrawalPurpose,
  ) {
    const existing = await tx.withdrawalRequest.findUnique({
      where: {
        userId_clientIdempotencyKey: {
          userId,
          clientIdempotencyKey: idempotencyKey,
        },
      },
      select: {
        ...withdrawalPublicSelect,
        bankAccountId: true,
        amount: true,
        purpose: true,
      },
    });
    if (!existing) return null;
    if (
      !existing.amount.equals(amount) ||
      existing.bankAccountId !== bankAccountId ||
      existing.purpose !== purpose
    ) {
      throw new ConflictException('IDEMPOTENCY_CONFLICT');
    }
    return this.toWithdrawal(existing);
  }

  private async attachBalances(
    client: PrismaService | Tx,
    userId: string,
    purpose: WithdrawalPurpose,
    withdrawal: ReturnType<WithdrawalsService['toWithdrawal']>,
  ) {
    const funds = await this.readFunds(client, userId, purpose);
    return {
      ...withdrawal,
      availableBalance: toMoneyString(funds.walletAvailable),
      eligibleAmount: toMoneyString(funds.eligibleRemaining),
      reservedAmount: toMoneyString(funds.reserved),
      withdrawableAmount: toMoneyString(funds.withdrawable),
    };
  }

  private async sameBankAccount(
    userId: string,
    withdrawalId: string,
    bankAccountId: string,
  ) {
    const row = await this.prisma.withdrawalRequest.findFirst({
      where: { id: withdrawalId, userId, bankAccountId },
      select: { id: true },
    });
    return row != null;
  }

  private beneficiaryFields(purpose: WithdrawalPurpose, name: string) {
    return purpose === WithdrawalPurpose.CUSTOMER_REFERRAL
      ? { beneficiaryName: name, customerName: name }
      : { beneficiaryName: name, astrologerName: name };
  }

  private toBank(row: BankPublic) {
    return {
      id: row.id,
      bankName: row.bankName,
      accountHolderName: row.accountHolderName,
      branchName: row.branchName,
      bankCode: row.bankCode,
      branchCode: row.branchCode,
      accountNumberMasked: maskAccountNumber(row.accountNumberLast4),
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toWithdrawal(row: WithdrawalPublic) {
    return {
      id: row.id,
      amount: toMoneyString(row.amount),
      currency: row.currency,
      status: row.status,
      purpose: row.purpose,
      createdAt: row.createdAt.toISOString(),
      destination: {
        bankName: row.destinationBankName,
        accountHolderName: row.destinationAccountHolderName,
        branchName: row.destinationBranchName,
        bankCode: row.destinationBankCode,
        branchCode: row.destinationBranchCode,
        accountNumberMasked: maskAccountNumber(row.destinationAccountLast4),
      },
      approvedAt: row.approvedAt?.toISOString() ?? null,
      rejectedAt: row.rejectedAt?.toISOString() ?? null,
      rejectionReason: row.rejectionReason,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancellationReason: row.cancellationReason,
      paidAt: row.paidAt?.toISOString() ?? null,
      transferReference: row.transferReference,
      actualTransferredAt: row.actualTransferredAt?.toISOString() ?? null,
    };
  }
}

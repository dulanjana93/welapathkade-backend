/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest expect matchers */
import { ConflictException } from '@nestjs/common';
import { Prisma, WithdrawalStatus, type User } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';

const admin = { id: 'admin-1' } as User;

function publicRow(status: WithdrawalStatus) {
  const now = new Date('2026-10-25T00:00:00.000Z');
  return {
    id: 'w1',
    amount: new Prisma.Decimal('1000.00'),
    currency: 'LKR',
    status,
    createdAt: now,
    destinationBankName: 'Commercial Bank',
    destinationAccountHolderName: 'Nimal',
    destinationBranchName: 'Kandy',
    destinationBankCode: null,
    destinationBranchCode: null,
    destinationAccountLast4: '9012',
    approvedAt: now,
    rejectedAt: null,
    rejectionReason: null,
    cancelledAt: status === WithdrawalStatus.CANCELLED ? now : null,
    cancellationReason:
      status === WithdrawalStatus.CANCELLED
        ? 'Wallet shortfall after reversal'
        : null,
    paidAt: null,
    transferReference: null,
    actualTransferredAt: null,
  };
}

describe('WithdrawalsService.cancel', () => {
  function harness() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      withdrawalRequest: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      withdrawalEvent: { create: jest.fn().mockResolvedValue({}) },
      withdrawalDebit: { create: jest.fn() },
      ledgerEntry: { create: jest.fn(), update: jest.fn() },
      walletAccount: { update: jest.fn() },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    const redis = {
      incrFixedWindow: jest.fn().mockResolvedValue(1),
      getClient: () => ({
        incr: jest.fn(),
        expire: jest.fn(),
        eval: jest.fn(),
      }),
    };
    const service = new WithdrawalsService(
      prisma as never,
      {} as never,
      audit as never,
      redis as never,
    );
    return { tx, audit, prisma, service };
  }

  it('does not write an event, audit row, or debit when the claim loses', async () => {
    const { tx, audit, service } = harness();
    tx.withdrawalRequest.findUnique
      .mockResolvedValueOnce({
        id: 'w1',
        userId: 'u1',
        amount: new Prisma.Decimal('1000.00'),
        currency: 'LKR',
        status: WithdrawalStatus.APPROVED,
      })
      .mockResolvedValueOnce({ status: WithdrawalStatus.APPROVED });
    tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.cancel(
        admin,
        'w1',
        { reason: 'Wallet shortfall after reversal' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.withdrawalRequest.update).not.toHaveBeenCalled();
    expect(tx.withdrawalEvent.create).not.toHaveBeenCalled();
    expect(tx.withdrawalDebit.create).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    expect(tx.walletAccount.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('cancels an approved request once, with an event and audit, and no debit', async () => {
    const { tx, audit, prisma, service } = harness();
    tx.withdrawalRequest.findUnique
      .mockResolvedValueOnce({
        id: 'w1',
        userId: 'u1',
        amount: new Prisma.Decimal('1000.00'),
        currency: 'LKR',
        status: WithdrawalStatus.APPROVED,
      })
      .mockResolvedValueOnce({ status: WithdrawalStatus.APPROVED });
    tx.withdrawalRequest.updateMany.mockResolvedValue({ count: 1 });
    tx.withdrawalRequest.findUniqueOrThrow.mockResolvedValue(
      publicRow(WithdrawalStatus.CANCELLED),
    );

    const result = await service.cancel(
      admin,
      'w1',
      { reason: '  Wallet shortfall after reversal  ' },
      '127.0.0.1',
    );

    expect(result.status).toBe(WithdrawalStatus.CANCELLED);
    expect(result.cancellationReason).toBe('Wallet shortfall after reversal');
    expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', status: WithdrawalStatus.APPROVED },
      data: { status: WithdrawalStatus.CANCELLED },
    });
    expect(tx.withdrawalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CANCELLED',
          reason: 'Wallet shortfall after reversal',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'admin-1',
        action: 'WITHDRAWAL_CANCELLED',
        entityId: 'w1',
      }),
      tx,
    );
    expect(tx.withdrawalDebit.create).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    expect(tx.walletAccount.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

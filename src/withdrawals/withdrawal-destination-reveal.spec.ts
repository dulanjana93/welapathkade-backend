/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest matchers */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  UserRole,
  WithdrawalPurpose,
  WithdrawalStatus,
  type User,
} from '@prisma/client';
import { hashPassword } from '../common/crypto/password';
import { RedisService } from '../redis/redis.service';
import { WithdrawalsService } from './withdrawals.service';
import {
  WITHDRAWAL_DESTINATION_REVEALED_ACTION,
  WITHDRAWAL_REVEAL_PASSWORD_FAIL_MAX_PER_HOUR,
  WITHDRAWAL_REVEAL_PWD_FAIL_KEY_PREFIX,
  WITHDRAWAL_REVEAL_RATE_LIMIT_MESSAGE,
  WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX,
  WITHDRAWAL_REVEAL_SUCCESS_MAX_PER_HOUR,
  WITHDRAWAL_REVEAL_WINDOW_SECONDS,
} from './withdrawals.constants';

const PLAIN_ACCOUNT = '123456789012';
const LAST4 = '9012';

describe('WithdrawalsService.revealDestination', () => {
  const admin = { id: 'admin-1', role: UserRole.ADMIN } as User;

  async function harness(overrides?: {
    status?: WithdrawalStatus;
    purpose?: WithdrawalPurpose;
    ciphertext?: string | null;
    iv?: string | null;
    tag?: string | null;
    last4?: string | null;
    decryptResult?: string;
    decryptThrows?: boolean;
    auditFails?: boolean;
    password?: string;
    passwordHash?: string | null;
    actorRole?: UserRole;
    actorMissing?: boolean;
    withdrawalMissing?: boolean;
    bankAccountFindUnique?: jest.Mock;
    incrFixedWindow?: jest.Mock;
    incrFixedWindowImpl?: (key: string, window: number) => Promise<number>;
  }) {
    const password = overrides?.password ?? 'SecretPass1';
    const passwordHash =
      overrides?.passwordHash === null
        ? null
        : (overrides?.passwordHash ?? (await hashPassword(password)));

    const withdrawalRow = overrides?.withdrawalMissing
      ? null
      : {
          id: 'w1',
          status: overrides?.status ?? WithdrawalStatus.APPROVED,
          purpose: overrides?.purpose ?? WithdrawalPurpose.ASTROLOGER_EARNINGS,
          destinationBankName: 'Commercial Bank',
          destinationAccountHolderName: 'Nimal',
          destinationBranchName: 'Kandy',
          destinationBankCode: '7056',
          destinationBranchCode: '001',
          destinationAccountLast4: overrides?.last4 ?? LAST4,
          destinationAccountCiphertext:
            overrides?.ciphertext === undefined
              ? 'cipher-snapshot'
              : overrides.ciphertext,
          destinationAccountIv:
            overrides?.iv === undefined ? 'iv-snapshot' : overrides.iv,
          destinationAccountTag:
            overrides?.tag === undefined ? 'tag-snapshot' : overrides.tag,
        };

    const auditRecord = jest.fn().mockImplementation(async (params) => {
      if (overrides?.auditFails) {
        throw new Error('audit write failed');
      }
      return { id: 'audit-1', ...params };
    });

    const decrypt = jest.fn().mockImplementation(() => {
      if (overrides?.decryptThrows) {
        throw new Error('bad payload');
      }
      return overrides?.decryptResult ?? PLAIN_ACCOUNT;
    });

    const counters = new Map<string, number>();
    const incrFixedWindow =
      overrides?.incrFixedWindow ??
      jest.fn(
        async (key: string, windowSeconds: number) => {
          if (overrides?.incrFixedWindowImpl) {
            return overrides.incrFixedWindowImpl(key, windowSeconds);
          }
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return next;
        },
      );

    const bankAccountFindUnique =
      overrides?.bankAccountFindUnique ?? jest.fn();

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(
          overrides?.actorMissing
            ? null
            : {
                id: admin.id,
                role: overrides?.actorRole ?? UserRole.ADMIN,
                passwordHash,
              },
        ),
      },
      withdrawalRequest: {
        findUnique: jest.fn().mockResolvedValue(withdrawalRow),
        update: jest.fn(),
        updateMany: jest.fn(),
        aggregate: jest.fn(),
      },
      withdrawalDebit: {
        findUnique: jest.fn(),
        create: jest.fn(),
        aggregate: jest.fn(),
      },
      ledgerEntry: { create: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
      walletAccount: { findUnique: jest.fn(), update: jest.fn() },
      astrologerBankAccount: {
        findUnique: bankAccountFindUnique,
      },
      $transaction: jest.fn(),
    };

    const service = new WithdrawalsService(
      prisma as never,
      { decrypt, encrypt: jest.fn() } as never,
      { record: auditRecord } as never,
      { incrFixedWindow, getClient: jest.fn() } as never,
    );

    return {
      service,
      prisma,
      decrypt,
      auditRecord,
      incrFixedWindow,
      counters,
      password,
      bankAccountFindUnique,
    };
  }

  it('successful reveal decrypts the frozen destination snapshot', async () => {
    const { service, decrypt, auditRecord, incrFixedWindow } = await harness();
    const result = await service.revealDestination(
      admin,
      'w1',
      { password: 'SecretPass1', reason: 'Manual bank transfer' },
      '127.0.0.1',
    );

    expect(decrypt).toHaveBeenCalledWith({
      ciphertext: 'cipher-snapshot',
      iv: 'iv-snapshot',
      tag: 'tag-snapshot',
      last4: LAST4,
    });
    expect(result.destination.accountNumber).toBe(PLAIN_ACCOUNT);
    expect(result.auditLogId).toBe('audit-1');
    expect(auditRecord).toHaveBeenCalled();
    expect(incrFixedWindow).toHaveBeenCalledWith(
      `${WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX}admin-1`,
      WITHDRAWAL_REVEAL_WINDOW_SECONDS,
    );
    expect(incrFixedWindow).not.toHaveBeenCalledWith(
      expect.stringContaining(WITHDRAWAL_REVEAL_PWD_FAIL_KEY_PREFIX),
      expect.anything(),
    );
  });

  it('later bank-account changes are never read for reveal', async () => {
    const bankAccountFindUnique = jest.fn();
    const { service } = await harness({ bankAccountFindUnique });
    await service.revealDestination(admin, 'w1', {
      password: 'SecretPass1',
      reason: 'Payout',
    });
    expect(bankAccountFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    [WithdrawalStatus.PENDING_REVIEW],
    [WithdrawalStatus.PAID],
    [WithdrawalStatus.REJECTED],
    [WithdrawalStatus.CANCELLED],
  ] as const)('rejects status %s', async (status) => {
    const { service } = await harness({ status });
    await expect(
      service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects missing withdrawal', async () => {
    const { service } = await harness({ withdrawalMissing: true });
    await expect(
      service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects non-ADMIN callers at the service layer', async () => {
    const { service, incrFixedWindow } = await harness();
    const publicUser = { id: 'admin-1', role: UserRole.PUBLIC } as User;
    await expect(
      service.revealDestination(publicUser, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(incrFixedWindow).not.toHaveBeenCalled();
  });

  it('rejects incorrect password without consuming reveal quota', async () => {
    const { service, incrFixedWindow, decrypt } = await harness({
      password: 'SecretPass1',
    });
    await expect(
      service.revealDestination(
        admin,
        'w1',
        { password: 'WrongPass99', reason: 'Need account' },
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(decrypt).not.toHaveBeenCalled();
    expect(incrFixedWindow).toHaveBeenCalledTimes(1);
    expect(incrFixedWindow).toHaveBeenCalledWith(
      `${WITHDRAWAL_REVEAL_PWD_FAIL_KEY_PREFIX}admin-1:10.0.0.1`,
      WITHDRAWAL_REVEAL_WINDOW_SECONDS,
    );
    expect(incrFixedWindow).not.toHaveBeenCalledWith(
      `${WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX}admin-1`,
      expect.anything(),
    );
  });

  it('limits five failed password attempts then returns generic 429', async () => {
    const { service, incrFixedWindow } = await harness({
      password: 'SecretPass1',
    });

    for (let i = 0; i < WITHDRAWAL_REVEAL_PASSWORD_FAIL_MAX_PER_HOUR; i += 1) {
      await expect(
        service.revealDestination(
          admin,
          'w1',
          { password: 'WrongPass99', reason: 'attempt' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }

    await expect(
      service.revealDestination(
        admin,
        'w1',
        { password: 'WrongPass99', reason: 'attempt' },
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: WITHDRAWAL_REVEAL_RATE_LIMIT_MESSAGE,
    } satisfies Partial<HttpException>);

    expect(incrFixedWindow).toHaveBeenCalledTimes(
      WITHDRAWAL_REVEAL_PASSWORD_FAIL_MAX_PER_HOUR + 1,
    );
    expect(incrFixedWindow).not.toHaveBeenCalledWith(
      `${WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX}admin-1`,
      expect.anything(),
    );
  });

  it('allows five successful reveals then rejects the sixth before decryption', async () => {
    const { service, decrypt, incrFixedWindow } = await harness();

    for (let i = 0; i < WITHDRAWAL_REVEAL_SUCCESS_MAX_PER_HOUR; i += 1) {
      await service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: `Transfer ${i + 1}`,
      });
    }
    expect(decrypt).toHaveBeenCalledTimes(
      WITHDRAWAL_REVEAL_SUCCESS_MAX_PER_HOUR,
    );

    decrypt.mockClear();
    await expect(
      service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'One more',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: WITHDRAWAL_REVEAL_RATE_LIMIT_MESSAGE,
    } satisfies Partial<HttpException>);
    expect(decrypt).not.toHaveBeenCalled();
    expect(incrFixedWindow).toHaveBeenCalledWith(
      `${WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX}admin-1`,
      WITHDRAWAL_REVEAL_WINDOW_SECONDS,
    );
  });

  it('password failures do not consume the successful reveal quota', async () => {
    const { service, incrFixedWindow, counters } = await harness({
      password: 'SecretPass1',
    });

    await expect(
      service.revealDestination(
        admin,
        'w1',
        { password: 'WrongPass99', reason: 'fail' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await service.revealDestination(
      admin,
      'w1',
      { password: 'SecretPass1', reason: 'ok' },
      '127.0.0.1',
    );

    expect(
      counters.get(`${WITHDRAWAL_REVEAL_PWD_FAIL_KEY_PREFIX}admin-1:127.0.0.1`),
    ).toBe(1);
    expect(counters.get(`${WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX}admin-1`)).toBe(
      1,
    );
    expect(incrFixedWindow).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Redis is unavailable during failed-password limiting', async () => {
    const { service } = await harness({
      password: 'SecretPass1',
      incrFixedWindowImpl: async () => {
        throw new Error('Redis connection refused');
      },
    });
    await expect(
      service.revealDestination(
        admin,
        'w1',
        { password: 'WrongPass99', reason: 'fail' },
        '127.0.0.1',
      ),
    ).rejects.toThrow(/Redis connection refused/);
  });

  it('fails closed when Redis is unavailable during reveal quota enforcement', async () => {
    const { service, decrypt } = await harness({
      incrFixedWindowImpl: async () => {
        throw new Error('Redis connection refused');
      },
    });
    await expect(
      service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toThrow(/Redis connection refused/);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('passes fixed-window seconds to Redis and uses distinct key prefixes', async () => {
    const incrFixedWindow = jest.fn().mockResolvedValue(1);
    const { service } = await harness({
      password: 'SecretPass1',
      incrFixedWindow,
    });

    await expect(
      service.revealDestination(
        admin,
        'w1',
        { password: 'bad', reason: 'fail' },
        '::1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    incrFixedWindow.mockResolvedValue(1);
    await service.revealDestination(
      admin,
      'w1',
      { password: 'SecretPass1', reason: 'ok' },
      '::1',
    );

    expect(incrFixedWindow.mock.calls[0]).toEqual([
      `${WITHDRAWAL_REVEAL_PWD_FAIL_KEY_PREFIX}admin-1:::1`,
      WITHDRAWAL_REVEAL_WINDOW_SECONDS,
    ]);
    expect(incrFixedWindow.mock.calls[1]).toEqual([
      `${WITHDRAWAL_REVEAL_SUCCESS_KEY_PREFIX}admin-1`,
      WITHDRAWAL_REVEAL_WINDOW_SECONDS,
    ]);
  });

  it('rejects missing or malformed encrypted snapshots', async () => {
    const missing = await harness({ ciphertext: '', iv: '', tag: '' });
    await expect(
      missing.service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const badDecrypt = await harness({ decryptThrows: true });
    await expect(
      badDecrypt.service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const mismatch = await harness({ decryptResult: '999999999999' });
    await expect(
      mismatch.service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates audit without plaintext and fails closed on audit error', async () => {
    const ok = await harness();
    await ok.service.revealDestination(admin, 'w1', {
      password: 'SecretPass1',
      reason: 'Manual transfer confirmation',
    });
    expect(ok.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'admin-1',
        action: WITHDRAWAL_DESTINATION_REVEALED_ACTION,
        entityId: 'w1',
        newData: expect.objectContaining({
          accountNumberMasked: '••••9012',
          accountNumberLast4: LAST4,
        }),
      }),
    );
    const payload = JSON.stringify(ok.auditRecord.mock.calls[0][0]);
    expect(payload).not.toContain(PLAIN_ACCOUNT);
    expect(payload).not.toContain('cipher-snapshot');
    expect(payload).not.toContain('SecretPass1');

    const failing = await harness({ auditFails: true });
    await expect(
      failing.service.revealDestination(admin, 'w1', {
        password: 'SecretPass1',
        reason: 'Need account',
      }),
    ).rejects.toThrow(/audit write failed/);
  });

  it('response never includes ciphertext or encryption metadata', async () => {
    const { service } = await harness();
    const result = await service.revealDestination(admin, 'w1', {
      password: 'SecretPass1',
      reason: 'Need account',
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('cipher-snapshot');
    expect(json).not.toContain('iv-snapshot');
    expect(json).not.toContain('tag-snapshot');
    expect(result).not.toHaveProperty('destinationAccountCiphertext');
  });

  it('keeps list/detail masked and supports customer referral purpose', async () => {
    const detailHarness = await harness();
    const now = new Date('2026-10-25T00:00:00.000Z');
    detailHarness.prisma.withdrawalRequest.findUnique.mockResolvedValueOnce({
      id: 'w1',
      amount: new Prisma.Decimal('1000.00'),
      currency: 'LKR',
      status: WithdrawalStatus.APPROVED,
      purpose: WithdrawalPurpose.ASTROLOGER_EARNINGS,
      createdAt: now,
      destinationBankName: 'Commercial Bank',
      destinationAccountHolderName: 'Nimal',
      destinationBranchName: 'Kandy',
      destinationBankCode: null,
      destinationBranchCode: null,
      destinationAccountLast4: LAST4,
      approvedAt: now,
      rejectedAt: null,
      rejectionReason: null,
      cancelledAt: null,
      cancellationReason: null,
      paidAt: null,
      transferReference: null,
      actualTransferredAt: null,
      userId: 'u1',
      bankAccountId: 'ba1',
      user: { id: 'u1', name: 'Nimal' },
      events: [],
      debit: null,
    });
    detailHarness.prisma.walletAccount.findUnique = jest
      .fn()
      .mockResolvedValue({
        availableBalance: new Prisma.Decimal('5000.00'),
        currency: 'LKR',
      });
    detailHarness.prisma.ledgerEntry.groupBy = jest.fn().mockResolvedValue([]);
    detailHarness.prisma.withdrawalRequest.aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } });
    detailHarness.prisma.withdrawalDebit.aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { amount: null } });

    const detail = await detailHarness.service.getAdmin('w1');
    expect(detail.destination.accountNumberMasked).toBe('••••9012');
    expect(detail.destination).not.toHaveProperty('accountNumber');
    expect(JSON.stringify(detail)).not.toContain(PLAIN_ACCOUNT);

    const referral = await harness({
      purpose: WithdrawalPurpose.CUSTOMER_REFERRAL,
    });
    const result = await referral.service.revealDestination(admin, 'w1', {
      password: 'SecretPass1',
      reason: 'Referral payout transfer',
    });
    expect(result.purpose).toBe(WithdrawalPurpose.CUSTOMER_REFERRAL);
  });

  it('does not modify withdrawal status, wallet, debit, or ledger', async () => {
    const { service, prisma } = await harness();
    await service.revealDestination(admin, 'w1', {
      password: 'SecretPass1',
      reason: 'Need account',
    });
    expect(prisma.withdrawalRequest.update).not.toHaveBeenCalled();
    expect(prisma.withdrawalRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.withdrawalDebit.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.walletAccount.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('RedisService.incrFixedWindow (unit, mocked client)', () => {
  it('evaluates Lua with key and window seconds and returns numeric count', async () => {
    const evalMock = jest.fn().mockResolvedValue(3);
    const service = Object.create(RedisService.prototype) as {
      client: { eval: typeof evalMock };
    };
    service.client = { eval: evalMock };

    const count = await RedisService.prototype.incrFixedWindow.call(
      service,
      'admin:withdrawal-reveal:success:admin-1',
      3600,
    );

    expect(count).toBe(3);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const args = evalMock.mock.calls[0];
    expect(args[0]).toContain("redis.call('INCR'");
    expect(args[0]).toContain("redis.call('EXPIRE'");
    expect(args[1]).toBe(1);
    expect(args[2]).toBe('admin:withdrawal-reveal:success:admin-1');
    expect(args[3]).toBe('3600');
  });

  it('fails closed on non-numeric Lua results', async () => {
    const service = Object.create(RedisService.prototype) as {
      client: { eval: jest.Mock };
    };
    service.client = { eval: jest.fn().mockResolvedValue('nope') };
    await expect(
      RedisService.prototype.incrFixedWindow.call(service, 'k', 3600),
    ).rejects.toThrow(/non-numeric/);
  });
});

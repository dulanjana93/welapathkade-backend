import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompletePreapprovalDto } from './dto/complete-preapproval.dto';
import { SavedCardController } from './saved-card.controller';

describe('SavedCardController authorization', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  function context(role: UserRole) {
    return {
      getHandler: () => SavedCardController.prototype.list,
      getClass: () => SavedCardController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as never;
  }

  it('allows only the public customer role', () => {
    expect(reflector.get(ROLES_KEY, SavedCardController)).toEqual([
      UserRole.PUBLIC,
    ]);
    expect(() => guard.canActivate(context(UserRole.ASTROLOGER))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(context(UserRole.PUBLIC))).toBe(true);
  });
});

describe('SavedCardController complete', () => {
  it('passes only the caller id, card id, and informational outcome', async () => {
    const result = {
      status: 'FAILED',
      savedCard: null,
      failedRegistration: { id: 'card-1' },
    };
    const service = { complete: jest.fn().mockResolvedValue(result) };
    const controller = new SavedCardController(service as never);
    await expect(
      controller.complete({ id: 'user-1' } as never, 'card-1', {
        outcome: 'CANCELLED',
      }),
    ).resolves.toBe(result);
    expect(service.complete).toHaveBeenCalledWith('user-1', 'card-1', 'CANCELLED');
  });
});

describe('CompletePreapprovalDto', () => {
  it('accepts a known outcome or none and rejects anything else', async () => {
    const errors = async (body: object) =>
      (await validate(plainToInstance(CompletePreapprovalDto, body))).length;
    await expect(errors({})).resolves.toBe(0);
    await expect(errors({ outcome: 'RETURNED' })).resolves.toBe(0);
    await expect(errors({ outcome: 'ACTIVE' })).resolves.toBe(1);
  });
});

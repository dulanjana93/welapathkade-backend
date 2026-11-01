import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
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

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminRefundsController } from './admin-refunds.controller';

describe('AdminRefundsController', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  function context(role: UserRole) {
    return {
      getHandler: () => AdminRefundsController.prototype.list,
      getClass: () => AdminRefundsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as never;
  }

  it('rejects a non-admin and allows an admin', () => {
    expect(reflector.get(ROLES_KEY, AdminRefundsController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(() => guard.canActivate(context(UserRole.PUBLIC))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(context(UserRole.ADMIN))).toBe(true);
  });
});

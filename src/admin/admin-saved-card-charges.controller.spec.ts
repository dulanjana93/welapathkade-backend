import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminSavedCardChargesController } from './admin-saved-card-charges.controller';

describe('Admin saved-card charge reconciliation authorization', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  function context(role: UserRole) {
    return {
      getHandler: () => AdminSavedCardChargesController.prototype.reconcileOne,
      getClass: () => AdminSavedCardChargesController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as never;
  }

  it('allows only an admin to reconcile, and reconciliation does not charge', () => {
    expect(reflector.get(ROLES_KEY, AdminSavedCardChargesController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(() => guard.canActivate(context(UserRole.PUBLIC))).toThrow(
      ForbiddenException,
    );
    const charges = {
      reconcileOne: jest.fn(),
      reconcileUnresolved: jest.fn(),
      listForAdmin: jest.fn(),
    };
    const controller = new AdminSavedCardChargesController(charges as never);
    void controller.reconcileOne('att-1');
    expect(charges.reconcileOne).toHaveBeenCalledWith('att-1');
    expect(charges).not.toHaveProperty('charge');
  });
});

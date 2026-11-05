import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminConsultationsController } from './admin-consultations.controller';

describe('AdminConsultationsController', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const consultations = {
    list: jest.fn().mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] }),
    getById: jest.fn().mockResolvedValue({ id: 'c-1' }),
  };
  const controller = new AdminConsultationsController(consultations as never);

  function contextFor(
    handler: (...args: never[]) => unknown,
    role: UserRole,
  ) {
    return {
      getHandler: () => handler,
      getClass: () => AdminConsultationsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as never;
  }

  it('requires ADMIN on the controller', () => {
    expect(reflector.get(ROLES_KEY, AdminConsultationsController)).toEqual([
      UserRole.ADMIN,
    ]);
  });

  it('rejects non-admin for list and get', () => {
    expect(() =>
      guard.canActivate(
        contextFor(AdminConsultationsController.prototype.list, UserRole.PUBLIC),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(
        contextFor(
          AdminConsultationsController.prototype.get,
          UserRole.ASTROLOGER,
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows ADMIN and delegates to the read-only service', async () => {
    expect(
      guard.canActivate(
        contextFor(AdminConsultationsController.prototype.list, UserRole.ADMIN),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        contextFor(AdminConsultationsController.prototype.get, UserRole.ADMIN),
      ),
    ).toBe(true);

    await controller.list({ page: 1, pageSize: 20 });
    await controller.get('c-1');
    expect(consultations.list).toHaveBeenCalled();
    expect(consultations.getById).toHaveBeenCalledWith('c-1');
  });
});

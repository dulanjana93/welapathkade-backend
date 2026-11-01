import 'reflect-metadata';
import { validate } from 'class-validator';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SavedCardCheckoutDto } from './dto/saved-card-checkout.dto';
import { SavedCardChargeController } from './saved-card-charge.controller';

describe('Saved-card checkout authorization', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  function context(role: UserRole) {
    return {
      getHandler: () => SavedCardChargeController.prototype.charge,
      getClass: () => SavedCardChargeController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as never;
  }

  it('allows only the public customer and requires explicit confirmation', async () => {
    expect(reflector.get(ROLES_KEY, SavedCardChargeController)).toEqual([
      UserRole.PUBLIC,
    ]);
    expect(() => guard.canActivate(context(UserRole.ASTROLOGER))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(context(UserRole.PUBLIC))).toBe(true);
    const accepted = new SavedCardCheckoutDto();
    accepted.confirmSavedCardPayment = true;
    expect(await validate(accepted)).toHaveLength(0);
    const missing = new SavedCardCheckoutDto();
    expect(await validate(missing)).not.toHaveLength(0);
  });
});

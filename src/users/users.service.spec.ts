import { BadRequestException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService referral rules', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };

  const service = new UsersService(
    prisma as never,
    { record: jest.fn() } as never,
  );

  it('rejects invalid referral codes', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.resolvePublicReferrer('MISSING'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-public referrers', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: '1',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    });
    await expect(
      service.resolvePublicReferrer('ADMIN1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts active public referrers', async () => {
    const referrer = {
      id: 'ref-1',
      role: UserRole.PUBLIC,
      status: UserStatus.ACTIVE,
    };
    prisma.user.findUnique.mockResolvedValue(referrer);
    await expect(service.resolvePublicReferrer('ABCD1234')).resolves.toEqual(
      referrer,
    );
  });
});

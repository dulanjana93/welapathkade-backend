import { ForbiddenException } from '@nestjs/common';
import {
  AstrologerProfileStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AstrologersService } from './astrologers.service';
import { toOwnProfileView, toPublicAstrologerView } from './astrologer.mapper';

describe('astrologer online status', () => {
  const prisma = {
    astrologerProfile: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const reviews = {
    aggregateForAstrologer: jest
      .fn()
      .mockResolvedValue({ averageRating: null, reviewCount: 0 }),
  };
  const service = new AstrologersService(
    prisma as never,
    { write: jest.fn() } as never,
    {
      hasConfiguredAvailability: jest.fn().mockResolvedValue(true),
    } as never,
    reviews as never,
  );

  const astroUser = {
    id: 'u1',
    role: UserRole.ASTROLOGER,
    status: UserStatus.ACTIVE,
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults new profiles to Offline in mapper views', () => {
    const profile = {
      id: 'p1',
      displayName: 'Guru',
      bio: null,
      experienceYears: 1,
      photo: null,
      city: null,
      district: null,
      status: AstrologerProfileStatus.ACTIVE,
      isOnline: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never;
    expect(toPublicAstrologerView(profile, []).isOnline).toBe(false);
    expect(
      toOwnProfileView(profile, {
        hasActiveService: true,
        userActive: true,
      }).isOnline,
    ).toBe(false);
  });

  it('authenticated astrologer can switch Online and Offline', async () => {
    prisma.astrologerProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      services: [{ id: 's1' }],
    });
    prisma.astrologerProfile.update.mockResolvedValue({
      id: 'p1',
      isOnline: true,
    });
    await expect(
      service.updateOwnOnlineStatus(astroUser, { isOnline: true }),
    ).resolves.toEqual({ id: 'p1', isOnline: true });

    prisma.astrologerProfile.update.mockResolvedValue({
      id: 'p1',
      isOnline: false,
    });
    await expect(
      service.updateOwnOnlineStatus(astroUser, { isOnline: false }),
    ).resolves.toEqual({ id: 'p1', isOnline: false });
  });

  it('rejects non-astrologers', async () => {
    await expect(
      service.updateOwnOnlineStatus(
        { id: 'c1', role: UserRole.PUBLIC, status: UserStatus.ACTIVE } as never,
        { isOnline: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.astrologerProfile.update).not.toHaveBeenCalled();
  });
});

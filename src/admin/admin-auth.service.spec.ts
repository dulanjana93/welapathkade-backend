import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { AdminAuthService } from './admin-auth.service';
import { hashPassword } from '../common/crypto/password';

describe('AdminAuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };

  const usersService = {
    assertCanAuthenticate: jest.fn(),
    toAuthMeView: jest.fn(),
  };

  const tokenService = {
    issueSession: jest.fn(),
    rotateRefreshToken: jest.fn(),
    revokeRefreshToken: jest.fn(),
  };

  const authService = {
    logout: jest.fn(),
  };

  let service: AdminAuthService;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword('SecretPass1');
  });

  beforeEach(() => {
    jest.resetAllMocks();
    service = new AdminAuthService(
      prisma as never,
      usersService as never,
      tokenService as never,
      authService as never,
    );
  });

  function adminUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'admin-1',
      email: 'admin@welapathkade.local',
      phone: 'admin:admin@welapathkade.local',
      passwordHash,
      name: 'Platform Admin',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      language: 'EN',
      referralCode: 'ADM001',
      referredByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it('logs in with valid email/password and issues tokens', async () => {
    const user = adminUser();
    prisma.user.findUnique.mockResolvedValue(user);
    usersService.toAuthMeView.mockResolvedValue({
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      role: user.role,
      status: user.status,
    });
    tokenService.issueSession.mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
      sessionId: 'sess-1',
    });

    const result = await service.login({
      email: 'Admin@Welapathkade.local',
      password: 'SecretPass1',
    });

    expect(result.accessToken).toBe('access');
    expect(result.refreshToken).toBe('refresh');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(result)).not.toContain(passwordHash);
    expect(usersService.assertCanAuthenticate).toHaveBeenCalledWith(user);
  });

  it('rejects wrong password', async () => {
    prisma.user.findUnique.mockResolvedValue(adminUser());
    await expect(
      service.login({
        email: 'admin@welapathkade.local',
        password: 'WrongPassword',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenService.issueSession).not.toHaveBeenCalled();
  });

  it('rejects unknown email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.login({
        email: 'missing@welapathkade.local',
        password: 'SecretPass1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects non-admin email even with correct password hash', async () => {
    prisma.user.findUnique.mockResolvedValue(
      adminUser({ role: UserRole.PUBLIC }),
    );
    await expect(
      service.login({
        email: 'admin@welapathkade.local',
        password: 'SecretPass1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects suspended admin after password match', async () => {
    prisma.user.findUnique.mockResolvedValue(
      adminUser({ status: UserStatus.SUSPENDED }),
    );
    usersService.assertCanAuthenticate.mockImplementation(() => {
      throw new BadRequestException('Account is suspended');
    });

    await expect(
      service.login({
        email: 'admin@welapathkade.local',
        password: 'SecretPass1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects inactive admin', async () => {
    prisma.user.findUnique.mockResolvedValue(
      adminUser({ status: UserStatus.INACTIVE }),
    );
    usersService.assertCanAuthenticate.mockImplementation(() => {
      throw new BadRequestException('Account is inactive');
    });

    await expect(
      service.login({
        email: 'admin@welapathkade.local',
        password: 'SecretPass1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refreshes admin session', async () => {
    const user = adminUser();
    tokenService.rotateRefreshToken.mockResolvedValue({
      user,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 900,
      sessionId: 'sess-2',
    });
    usersService.toAuthMeView.mockResolvedValue({
      id: user.id,
      role: user.role,
      email: user.email,
    });

    const result = await service.refresh({ refreshToken: 'old-refresh' });
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
  });

  it('revokes rotated session when refresh user is not ADMIN', async () => {
    tokenService.rotateRefreshToken.mockResolvedValue({
      user: adminUser({ role: UserRole.ASTROLOGER }),
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 900,
      sessionId: 'sess-2',
    });

    await expect(
      service.refresh({ refreshToken: 'old-refresh' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith('new-refresh');
  });

  it('logout revokes session via auth service', async () => {
    authService.logout.mockResolvedValue({ message: 'Logged out' });
    await expect(service.logout('refresh-token')).resolves.toEqual({
      message: 'Logged out',
    });
    expect(authService.logout).toHaveBeenCalledWith('refresh-token');
  });
});

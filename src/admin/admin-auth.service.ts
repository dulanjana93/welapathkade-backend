import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';
import { verifyPassword } from '../common/crypto/password';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
  ) {}

  async login(params: {
    email: string;
    password: string;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const email = params.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Uniform invalid-credentials response — do not reveal which field failed.
    if (
      !user ||
      user.role !== UserRole.ADMIN ||
      !user.passwordHash ||
      !(await verifyPassword(user.passwordHash, params.password))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.usersService.assertCanAuthenticate(user);

    const tokens = await this.tokenService.issueSession({
      user,
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: await this.usersService.toAuthMeView(user),
    };
  }

  async refresh(params: {
    refreshToken: string;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const rotated = await this.tokenService.rotateRefreshToken(params);
    this.usersService.assertCanAuthenticate(rotated.user);

    if (rotated.user.role !== UserRole.ADMIN) {
      await this.tokenService.revokeRefreshToken(rotated.refreshToken);
      throw new UnauthorizedException('Admin session required');
    }

    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: rotated.expiresIn,
      user: await this.usersService.toAuthMeView(rotated.user),
    };
  }

  logout(refreshToken: string) {
    return this.authService.logout(refreshToken);
  }
}

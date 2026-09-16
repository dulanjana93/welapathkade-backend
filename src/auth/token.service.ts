import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User, UserRole } from '@prisma/client';
import { AUTH_CONSTANTS } from '../common/auth/auth.constants';
import {
  generateRefreshToken,
  hashRefreshToken,
} from '../common/crypto/hashing';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';

export type AccessTokenPayload = {
  sub: string;
  role: UserRole;
  sid: string;
};

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async issueSession(params: {
    user: User;
    deviceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(
      Date.now() + AUTH_CONSTANTS.REFRESH_TOKEN_TTL_SECONDS * 1000,
    );

    const session = await this.prisma.userSession.create({
      data: {
        userId: params.user.id,
        refreshTokenHash,
        deviceId: params.deviceId ?? null,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        expiresAt,
      },
    });

    const accessToken = await this.jwtService.signAsync(
      {
        sub: params.user.id,
        role: params.user.role,
        sid: session.id,
      } satisfies AccessTokenPayload,
      {
        secret: this.configService.getOrThrow<string>('app.jwtAccessSecret'),
        expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_TTL_SECONDS,
      },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_TTL_SECONDS,
      sessionId: session.id,
    };
  }

  async rotateRefreshToken(params: {
    refreshToken: string;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const refreshTokenHash = hashRefreshToken(params.refreshToken);

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.userSession.findFirst({
        where: { refreshTokenHash },
        include: { user: true },
      });

      if (!session) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (session.revokedAt) {
        throw new UnauthorizedException('Refresh token has been revoked');
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Refresh token has expired');
      }

      await tx.userSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });

      const nextRefreshToken = generateRefreshToken();
      const nextHash = hashRefreshToken(nextRefreshToken);
      const expiresAt = new Date(
        Date.now() + AUTH_CONSTANTS.REFRESH_TOKEN_TTL_SECONDS * 1000,
      );

      const nextSession = await tx.userSession.create({
        data: {
          userId: session.userId,
          refreshTokenHash: nextHash,
          deviceId: session.deviceId,
          ip: params.ip ?? session.ip,
          userAgent: params.userAgent ?? session.userAgent,
          expiresAt,
        },
      });

      const accessToken = await this.jwtService.signAsync(
        {
          sub: session.user.id,
          role: session.user.role,
          sid: nextSession.id,
        } satisfies AccessTokenPayload,
        {
          secret: this.configService.getOrThrow<string>('app.jwtAccessSecret'),
          expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_TTL_SECONDS,
        },
      );

      return {
        user: session.user,
        accessToken,
        refreshToken: nextRefreshToken,
        expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_TTL_SECONDS,
        sessionId: nextSession.id,
      };
    });
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const session = await this.prisma.userSession.findFirst({
      where: { refreshTokenHash, revokedAt: null },
    });

    if (!session) {
      return;
    }

    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
  }
}

import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminLoginDto,
  AdminLogoutDto,
  AdminRefreshDto,
} from './dto/admin-auth.dto';

@ApiTags('Admin Auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Admin email/password login' })
  @ApiOkResponse({ description: 'Access and refresh tokens issued' })
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.adminAuthService.login({
      email: dto.email,
      password: dto.password,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rotate admin refresh token' })
  refresh(@Body() dto: AdminRefreshDto, @Req() req: Request) {
    return this.adminAuthService.refresh({
      refreshToken: dto.refreshToken,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('logout')
  @ApiOperation({ summary: 'Revoke admin refresh-token session' })
  logout(@Body() dto: AdminLogoutDto) {
    return this.adminAuthService.logout(dto.refreshToken);
  }
}

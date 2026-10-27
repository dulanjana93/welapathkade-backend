import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DevicePlatform, type User } from '@prisma/client';
import type { Request } from 'express';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  LogoutDto,
  RefreshTokenDto,
  RegisterDeviceDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('otp/request')
  @ApiOperation({ summary: 'Request a phone OTP for login or registration' })
  @ApiOkResponse({ description: 'OTP dispatched via SMS provider' })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto.phone, dto.purpose);
  }

  @Post('otp/verify')
  @ApiOperation({
    summary: 'Verify OTP, create or login user, and issue tokens',
  })
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.authService.verifyOtp({
      phone: dto.phone,
      code: dto.code,
      name: dto.name,
      language: dto.language,
      referralCode: dto.referralCode,
      deviceId: dto.deviceId,
      fcmToken: dto.fcmToken,
      platform: dto.platform,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('refresh')
  @ApiOperation({
    summary: 'Rotate refresh token and issue a new access token',
  })
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refresh({
      refreshToken: dto.refreshToken,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('logout')
  @ApiOperation({ summary: 'Revoke a refresh-token session' })
  logout(@Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get the authenticated user profile (includes own phone)',
  })
  me(@CurrentUser() user: User) {
    return this.usersService.toAuthMeView(user);
  }

  @Post('devices')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Register or update an FCM device token for the current user',
  })
  registerDevice(@CurrentUser() user: User, @Body() dto: RegisterDeviceDto) {
    return this.authService.upsertDevice({
      userId: user.id,
      fcmToken: dto.fcmToken,
      platform: dto.platform,
    });
  }
}

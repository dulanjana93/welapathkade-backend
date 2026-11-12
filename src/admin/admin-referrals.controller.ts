import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UsersService } from '../users/users.service';

@ApiTags('Admin Referrals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/referrals')
export class AdminReferralsController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary:
      'List referral ownership for public and astrologer accounts (identity graph only)',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: [UserRole.PUBLIC, UserRole.ASTROLOGER],
  })
  @ApiQuery({
    name: 'attribution',
    required: false,
    enum: ['ALL', 'ATTRIBUTED', 'UNATTRIBUTED'],
  })
  list(
    @Query('role') role?: UserRole,
    @Query('attribution')
    attribution?: 'ALL' | 'ATTRIBUTED' | 'UNATTRIBUTED',
  ) {
    return this.usersService.adminListReferralRelationships({
      role,
      attribution,
    });
  }

  @Get('corrections')
  @ApiOperation({
    summary:
      'Recent referral attribution corrections (append-only; no finance rewrite)',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  corrections(@Query('limit') limit?: string) {
    const parsed =
      limit === undefined || limit === '' ? undefined : Number(limit);
    return this.usersService.adminListReferralCorrections(
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @Get('resolve-code')
  @ApiOperation({
    summary: 'Resolve a PUBLIC referrer by referral code for admin correction UI',
  })
  @ApiQuery({ name: 'code', required: true, type: String })
  resolveCode(@Query('code') code?: string) {
    return this.usersService.adminResolveReferrerCode(code ?? '');
  }
}

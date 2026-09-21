import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole, UserStatus, type User } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UpdateUserStatusDto } from '../users/dto/admin-user.dto';
import { UsersService } from '../users/users.service';

@ApiTags('Admin Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List platform users (optional role/status filters)' })
  @ApiQuery({ name: 'role', required: false, enum: UserRole })
  @ApiQuery({ name: 'status', required: false, enum: UserStatus })
  list(
    @Query('role') role?: UserRole,
    @Query('status') status?: UserStatus,
  ) {
    return this.usersService.adminList({ role, status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin detail view of a user' })
  get(@Param('id') id: string) {
    return this.usersService.adminGetById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user account status (ACTIVE/INACTIVE/SUSPENDED)' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.usersService.adminUpdateStatus({
      id,
      status: dto.status,
      actorAdminId: admin.id,
      ip: req.ip,
    });
  }
}

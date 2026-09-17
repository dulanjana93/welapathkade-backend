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
import {
  AstrologerApplicationStatus,
  UserRole,
  type User,
} from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AstrologersService } from '../astrologers/astrologers.service';
import {
  ReviewAstrologerApplicationDto,
  UpdateAstrologerStatusDto,
} from '../astrologers/dto/astrologer.dto';

@ApiTags('Admin Astrologers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/astrologers')
export class AdminAstrologersController {
  constructor(private readonly astrologersService: AstrologersService) {}

  @Get()
  @ApiOperation({ summary: 'List astrologers (optional application status filter)' })
  @ApiQuery({
    name: 'applicationStatus',
    required: false,
    enum: AstrologerApplicationStatus,
  })
  list(
    @Query('applicationStatus') applicationStatus?: AstrologerApplicationStatus,
  ) {
    return this.astrologersService.adminList({ applicationStatus });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin detail view of an astrologer' })
  get(@Param('id') id: string) {
    return this.astrologersService.adminGetById(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update astrologer profile status (operational suspension/activation)',
  })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAstrologerStatusDto,
  ) {
    return this.astrologersService.adminUpdateStatus(id, dto);
  }

  @Patch(':id/application')
  @ApiOperation({ summary: 'Approve or reject a pending astrologer application' })
  reviewApplication(
    @Param('id') id: string,
    @CurrentUser() admin: User,
    @Body() dto: ReviewAstrologerApplicationDto,
    @Req() req: Request,
  ) {
    return this.astrologersService.adminReviewApplication(
      id,
      admin,
      dto,
      req.ip,
    );
  }
}

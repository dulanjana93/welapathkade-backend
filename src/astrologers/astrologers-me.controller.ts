import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AstrologersService } from './astrologers.service';
import {
  AssignAstrologerServiceDto,
  CreateAstrologerProfileDto,
  UpdateAstrologerProfileDto,
  UpdateAstrologerServiceDto,
} from './dto/astrologer.dto';

@ApiTags('Astrologers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ASTROLOGER)
@Controller('astrologers/me')
export class AstrologersMeController {
  constructor(private readonly astrologersService: AstrologersService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current astrologer profile' })
  getMe(@CurrentUser() user: User) {
    return this.astrologersService.getOwnProfile(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create the current astrologer profile' })
  createMe(@CurrentUser() user: User, @Body() dto: CreateAstrologerProfileDto) {
    return this.astrologersService.createOwnProfile(user, dto);
  }

  @Patch()
  @ApiOperation({ summary: 'Update the current astrologer profile' })
  updateMe(@CurrentUser() user: User, @Body() dto: UpdateAstrologerProfileDto) {
    return this.astrologersService.updateOwnProfile(user, dto);
  }

  @Get('services')
  @ApiOperation({ summary: 'List services configured by the current astrologer' })
  listServices(@CurrentUser() user: User) {
    return this.astrologersService.listOwnServices(user);
  }

  @Post('services')
  @ApiOperation({ summary: 'Assign a platform service with a price' })
  assignService(
    @CurrentUser() user: User,
    @Body() dto: AssignAstrologerServiceDto,
  ) {
    return this.astrologersService.assignService(user, dto);
  }

  @Patch('services/:serviceId')
  @ApiOperation({ summary: 'Update own service price or status' })
  updateService(
    @CurrentUser() user: User,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateAstrologerServiceDto,
  ) {
    return this.astrologersService.updateOwnService(user, serviceId, dto);
  }

  @Delete('services/:serviceId')
  @ApiOperation({
    summary: 'Soft-deactivate an assigned service (keeps historical row)',
  })
  deactivateService(
    @CurrentUser() user: User,
    @Param('serviceId') serviceId: string,
  ) {
    return this.astrologersService.deactivateOwnService(user, serviceId);
  }

  @Get('onboarding')
  @ApiOperation({ summary: 'Get onboarding readiness and application state' })
  getOnboarding(@CurrentUser() user: User) {
    return this.astrologersService.getOnboarding(user);
  }

  @Get('application')
  @ApiOperation({ summary: 'Get the current astrologer application status' })
  getApplication(@CurrentUser() user: User) {
    return this.astrologersService.getApplication(user);
  }

  @Post('application/submit')
  @ApiOperation({ summary: 'Submit onboarding application for admin review' })
  submitApplication(@CurrentUser() user: User) {
    return this.astrologersService.submitApplication(user);
  }
}

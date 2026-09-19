import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import { AvailabilityService } from './availability.service';
import {
  CreateAvailabilityExceptionDto,
  PutWeeklyAvailabilityDto,
  UpdateAvailabilityExceptionDto,
} from './dto/availability.dto';

@ApiTags('Astrologer Availability')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ASTROLOGER)
@Controller('astrologers/me/availability')
export class AvailabilityMeController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Get()
  @ApiOperation({ summary: 'Get own weekly availability and exceptions' })
  getOwn(@CurrentUser() user: User) {
    return this.availabilityService.getOwnAvailability(user);
  }

  @Put()
  @ApiOperation({
    summary: 'Replace own weekly availability schedule (full replace)',
  })
  putWeekly(
    @CurrentUser() user: User,
    @Body() dto: PutWeeklyAvailabilityDto,
  ) {
    return this.availabilityService.putOwnWeeklyAvailability(user, dto);
  }

  @Get('exceptions')
  @ApiOperation({ summary: 'List own availability exceptions' })
  listExceptions(@CurrentUser() user: User) {
    return this.availabilityService.listOwnExceptions(user);
  }

  @Post('exceptions')
  @ApiOperation({ summary: 'Create an availability exception' })
  createException(
    @CurrentUser() user: User,
    @Body() dto: CreateAvailabilityExceptionDto,
  ) {
    return this.availabilityService.createOwnException(user, dto);
  }

  @Patch('exceptions/:id')
  @ApiOperation({ summary: 'Update an availability exception' })
  updateException(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityExceptionDto,
  ) {
    return this.availabilityService.updateOwnException(user, id, dto);
  }

  @Delete('exceptions/:id')
  @ApiOperation({ summary: 'Delete an availability exception' })
  deleteException(@CurrentUser() user: User, @Param('id') id: string) {
    return this.availabilityService.deleteOwnException(user, id);
  }
}

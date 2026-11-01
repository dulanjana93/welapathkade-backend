import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  BillingProfileResponseDto,
  UpsertBillingProfileDto,
} from './dto/billing-profile.dto';
import { UsersService } from './users.service';

@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PUBLIC)
@Controller('me/billing')
export class BillingProfileController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the signed-in customer billing profile',
    description:
      'Returns the billing fields stored on the customer account, the existing account phone, and whether the profile is complete enough for checkout. Incomplete profiles are returned; they are not an error. Registration does not require these fields.',
  })
  @ApiOkResponse({ type: BillingProfileResponseDto })
  @ApiForbiddenResponse({ description: 'PUBLIC role required' })
  getMine(@CurrentUser() user: User) {
    return this.usersService.getBillingProfile(user);
  }

  @Put()
  @ApiOperation({
    summary: 'Create or replace the signed-in customer billing profile',
    description:
      'Saves billing details for the authenticated customer only. All of first name, last name, email, address, city, and country are required. The account phone is not changed. This does not change the display name or the admin login email.',
  })
  @ApiOkResponse({ type: BillingProfileResponseDto })
  @ApiBadRequestResponse({
    description:
      'A required field is missing, blank, too long, or the email format is invalid.',
  })
  @ApiForbiddenResponse({ description: 'PUBLIC role required' })
  upsertMine(@CurrentUser() user: User, @Body() dto: UpsertBillingProfileDto) {
    return this.usersService.upsertBillingProfile(user, dto);
  }
}

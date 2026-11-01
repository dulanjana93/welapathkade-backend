import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SavedCardCheckoutDto } from './dto/saved-card-checkout.dto';
import { SavedCardChargeService } from './saved-card-charge.service';

@ApiTags('Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PUBLIC)
@Controller('consultations')
export class SavedCardChargeController {
  constructor(private readonly charges: SavedCardChargeService) {}

  @Post(':consultationId/proposals/:proposalId/checkout/saved-card')
  @ApiOperation({
    summary: 'Pay an accepted consultation with the saved card',
    description:
      'Charges only after the customer sends confirmSavedCardPayment: true. The amount and currency come from the accepted consultation, not the request body. One PayHere Charging API call is made for a new attempt. A repeated request returns the existing attempt and does not charge again. Manual checkout remains POST .../checkout and does not require a saved card. Accepting a proposal does not charge the card.',
  })
  charge(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Param('proposalId') proposalId: string,
    @Body() _dto: SavedCardCheckoutDto,
  ) {
    return this.charges.charge(user, consultationId, proposalId);
  }
}

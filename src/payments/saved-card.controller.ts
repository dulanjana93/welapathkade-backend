import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StartPreapprovalDto } from './dto/start-preapproval.dto';
import { SavedCardService } from './saved-card.service';

@ApiTags('Saved cards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PUBLIC)
@Controller('me/payment-methods')
export class SavedCardController {
  constructor(private readonly savedCards: SavedCardService) {}

  @Get()
  @ApiOperation({
    summary: 'Usable saved cards and any in-progress or failed registration',
    description:
      'Returns the consent text the customer must accept, usable ACTIVE cards, at most one PENDING registration, and (when no PENDING remains) the most recent FAILED registration for retry UI. FAILED rows are never chargeable methods. DISABLED and REMOVED rows stay stored and are omitted from methods. Tokens, secrets, and raw PayHere notifications are not included.',
  })
  @ApiForbiddenResponse({ description: 'PUBLIC role required' })
  list(@CurrentUser() user: User) {
    return this.savedCards.list(user.id);
  }

  @Post('preapproval')
  @ApiOperation({
    summary: 'Start PayHere card registration',
    description:
      'Requires a complete billing profile and acceptAutomaticPaymentConsent=true. Returns a form POST for PayHere pre-approval. The browser return URL does not activate the card. PayHere notifies this API separately. No consultation payment, appointment, or wallet credit is created. The form omits amount. PayHere documents a Rs. 1.00 verification charge that it refunds immediately.',
  })
  start(@CurrentUser() user: User, @Body() body: StartPreapprovalDto) {
    return this.savedCards.start(user, body.acceptAutomaticPaymentConsent);
  }

  @Post(':id/revoke-authorization')
  @ApiOperation({
    summary: 'Revoke automatic-payment authorization and disable the card',
    description:
      'Deletes the stored token immediately. The card cannot be charged or reused. A replacement card needs a new pre-approval and fresh consent. This does not call PayHere. PayHere pre-approval cancellation is a separate action in the PayHere merchant account and has no customer API.',
  })
  revoke(@CurrentUser() user: User, @Param('id') id: string) {
    return this.savedCards.revoke(user.id, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a saved card',
    description:
      'Disables the card, revokes automatic-payment authorization, and deletes the stored token. Repeating the request returns the same removed card. A new card requires fresh consent.',
  })
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.savedCards.remove(user.id, id);
  }
}

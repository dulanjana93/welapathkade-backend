import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SavedCardChargeService } from '../payments/saved-card-charge.service';
import { AdminRefundQueryDto } from './dto/admin-refund.dto';

/**
 * Uncertain saved-card charges. Reconciliation reads PayHere Retrieval.
 * It never sends another Charging API request.
 */
@ApiTags('Admin Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/finance')
export class AdminSavedCardChargesController {
  constructor(private readonly charges: SavedCardChargeService) {}

  @Get('saved-card-charges')
  @ApiOperation({
    summary: 'List saved-card charges that need reconciliation',
    description:
      'Attempts whose PayHere outcome is not known. Does not include tokens, OAuth credentials, or raw charge bodies.',
  })
  list(@Query() query: AdminRefundQueryDto) {
    return this.charges.listForAdmin(query.page, query.pageSize);
  }

  @Post('saved-card-charges/reconcile')
  @ApiOperation({
    summary: 'Reconcile unresolved saved-card charges through Retrieval',
    description:
      'Matches order id, amount, currency, and a stored payment id when one exists. An empty or ambiguous retrieval stays unresolved. Does not charge the card again.',
  })
  reconcileUnresolved() {
    return this.charges.reconcileUnresolved();
  }

  @Post('saved-card-charges/:attemptId/reconcile')
  @ApiOperation({
    summary: 'Reconcile one saved-card charge through Retrieval',
  })
  reconcileOne(@Param('attemptId') attemptId: string) {
    return this.charges.reconcileOne(attemptId);
  }
}

import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PayHereRefundService } from '../payments/payhere-refund.service';
import { AdminRefundQueryDto } from './dto/admin-refund.dto';

/**
 * Admin view of PayHere refund attempts.
 *
 * A refund obligation (`FULL_REFUND_DUE`) means the customer is owed a refund.
 * A refund request is the PayHere call. `PROCESSING` means PayHere has been
 * asked or Retrieval shows the refund is in progress. `SUCCEEDED` means PayHere
 * reported the refund processed or Retrieval shows `REFUNDED`. A ledger reversal
 * is a separate internal clawback of an already posted snapshot.
 *
 * Amounts are the captured consultation amount. This API does not accept an amount.
 */
@ApiTags('Admin Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/finance')
export class AdminRefundsController {
  constructor(private readonly refunds: PayHereRefundService) {}

  @Get('refunds')
  @ApiOperation({
    summary: 'List PayHere refund attempts',
    description:
      'Paginated internal refund records. Does not include merchant credentials, OAuth tokens, raw provider payloads, or card data.',
  })
  list(@Query() query: AdminRefundQueryDto) {
    return this.refunds.list(query);
  }

  @Get('chargebacks')
  @ApiOperation({
    summary: 'List stored PayHere chargeback notifications',
    description:
      'Status -3 notifications. A chargeback is not a successful payment and does not start a refund. Unresolved chargebacks are flagged for manual review so settlement does not add a new credit. A snapshot already posted is not reversed by this phase.',
  })
  chargebacks(@Query() query: AdminRefundQueryDto) {
    return this.refunds.listChargebacks(query.page, query.pageSize);
  }

  @Post('refunds/reconcile')
  @ApiOperation({
    summary: 'Reconcile unresolved PayHere refunds',
    description:
      'Reads PayHere Retrieval for pending, processing, uncertain, and not-yet-retryable refunds. Does not send a new refund request. The expiry sweep calls the same operation.',
  })
  reconcileUnresolved() {
    return this.refunds.reconcileUnresolved();
  }

  @Get('refunds/:id')
  @ApiOperation({
    summary: 'View one PayHere refund and its payment history',
  })
  get(@Param('id') id: string) {
    return this.refunds.get(id);
  }

  @Post('refunds/:id/reconcile')
  @ApiOperation({
    summary: 'Reconcile one PayHere refund through Retrieval',
    description:
      'Matches the stored PayHere payment id. A different payment id on the same order is ignored. Retrieval that does not identify the payment leaves the refund unresolved.',
  })
  reconcileOne(@Param('id') id: string) {
    return this.refunds.reconcileOne(id);
  }

  @Post('refunds/:id/retry')
  @ApiOperation({
    summary: 'Retry a full refund only when Retrieval shows it never started',
    description:
      'Accepted only when the previous attempt is FAILED, retrySafe, and no longer holding the payment refund slot. Uncertain, processing, and successful refunds are rejected. The amount is the captured consultation amount.',
  })
  retry(@Param('id') id: string) {
    return this.refunds.retry(id);
  }
}

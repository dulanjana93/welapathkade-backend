import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CancelWithdrawalDto,
  MarkWithdrawalPaidDto,
  RejectWithdrawalDto,
  AdminWithdrawalQueryDto,
} from '../withdrawals/dto/withdrawal.dto';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { AdminFinanceService } from './admin-finance.service';
import {
  AdminAttentionCasesQueryDto,
  AdminLedgerQueryDto,
  FinanceDateRangeQueryDto,
} from './dto/admin-finance.dto';

@ApiTags('Admin Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(
    private readonly finance: AdminFinanceService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Financial aggregates by optional UTC half-open date range. The withdrawals object is astrologer earnings only; customer referral payouts and their sum are separate.',
  })
  overview(@Query() query: FinanceDateRangeQueryDto) {
    return this.finance.overview(query);
  }

  @Get('ledger')
  @ApiOperation({
    summary: 'Paginated ledger explorer with filters (admin read-only)',
  })
  ledger(@Query() query: AdminLedgerQueryDto) {
    return this.finance.listLedger(query);
  }

  @Get('reconcile')
  @ApiOperation({
    summary:
      'On-demand read-only reconciliation report (never mutates financial data)',
  })
  reconcile() {
    return this.finance.reconcile();
  }

  @Get('attention-cases')
  @ApiOperation({
    summary:
      'Appointments with refund obligation or manual review (admin inspection only)',
  })
  attentionCases(@Query() query: AdminAttentionCasesQueryDto) {
    return this.finance.listAttentionCases(query);
  }

  @Get('withdrawals')
  @ApiOperation({
    summary:
      'Paginated payout requests. Omitting purpose keeps the astrologer earnings list. purpose=CUSTOMER_REFERRAL lists customer referral payouts.',
  })
  listWithdrawals(@Query() query: AdminWithdrawalQueryDto) {
    return this.withdrawals.listAdmin(query);
  }

  @Get('withdrawals/:id')
  @ApiOperation({
    summary: 'Withdrawal detail with audit events (masked bank data)',
  })
  getWithdrawal(@Param('id') id: string) {
    return this.withdrawals.getAdmin(id);
  }

  @Post('withdrawals/:id/approve')
  @ApiOperation({
    summary:
      'Approve a pending request. Does not debit the wallet or mark it paid.',
  })
  approve(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.withdrawals.approve(admin, id, req.ip);
  }

  @Post('withdrawals/:id/reject')
  @ApiOperation({
    summary: 'Reject a pending request and release its reservation once',
  })
  reject(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: RejectWithdrawalDto,
    @Req() req: Request,
  ) {
    return this.withdrawals.reject(admin, id, dto, req.ip);
  }

  @Post('withdrawals/:id/cancel')
  @ApiOperation({
    summary:
      'Cancel an approved request that cannot be paid. Releases the reservation and does not post a debit.',
  })
  cancel(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: CancelWithdrawalDto,
    @Req() req: Request,
  ) {
    return this.withdrawals.cancel(admin, id, dto, req.ip);
  }

  @Post('withdrawals/:id/mark-paid')
  @ApiOperation({
    summary:
      'Record a confirmed manual bank transfer. Posts one withdrawal debit and reduces the wallet.',
  })
  markPaid(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: MarkWithdrawalPaidDto,
    @Req() req: Request,
  ) {
    return this.withdrawals.markPaid(admin, id, dto, req.ip);
  }
}

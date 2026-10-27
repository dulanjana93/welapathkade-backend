import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole, WithdrawalPurpose, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CreateBankAccountDto,
  CreateWithdrawalDto,
  UpdateBankAccountDto,
  WithdrawalListQueryDto,
} from './dto/withdrawal.dto';
import { WithdrawalsService } from './withdrawals.service';

function parseIdempotencyKey(raw?: string): string | null {
  if (raw == null || raw.trim() === '') return null;
  const key = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
    throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
  }
  return key;
}

@ApiTags('Customer referral payouts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PUBLIC)
@Controller('me/referral-payouts')
export class CustomerReferralPayoutsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Post('bank-accounts')
  @ApiOperation({
    summary:
      'Register the signed-in customer bank account. The number is encrypted.',
  })
  createBankAccount(
    @CurrentUser() user: User,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.withdrawals.createBankAccount(user, dto);
  }

  @Get('bank-accounts')
  @ApiOperation({
    summary: 'List own bank accounts with masked account numbers',
  })
  listBankAccounts(@CurrentUser() user: User) {
    return this.withdrawals.listBankAccounts(user);
  }

  @Patch('bank-accounts/:id')
  @ApiOperation({ summary: 'Update or deactivate own bank account' })
  updateBankAccount(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.withdrawals.updateBankAccount(user, id, dto);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Eligible customer referral balance, reservations, and amount available to request',
  })
  summary(@CurrentUser() user: User) {
    return this.withdrawals.referralPayoutSummary(user);
  }

  @Post()
  @ApiOperation({
    summary:
      'Request a customer referral payout. Reserves eligible earnings until an admin acts. This does not transfer money.',
  })
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateWithdrawalDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.withdrawals.createWithdrawal(
      user,
      dto,
      parseIdempotencyKey(idempotencyKey),
      WithdrawalPurpose.CUSTOMER_REFERRAL,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Paginated own customer referral payout history' })
  list(@CurrentUser() user: User, @Query() query: WithdrawalListQueryDto) {
    return this.withdrawals.listMine(
      user,
      query,
      WithdrawalPurpose.CUSTOMER_REFERRAL,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Own customer referral payout detail with a masked destination',
  })
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.withdrawals.getMine(
      user,
      id,
      WithdrawalPurpose.CUSTOMER_REFERRAL,
    );
  }
}

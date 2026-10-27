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
import { UserRole, type User } from '@prisma/client';
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

@ApiTags('Astrologer withdrawals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ASTROLOGER)
@Controller('astrologers/me')
export class AstrologerWithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Post('bank-accounts')
  @ApiOperation({
    summary: 'Register a bank account (account number stored encrypted)',
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

  @Get('withdrawals/summary')
  @ApiOperation({
    summary:
      'Wallet balance, reserved withdrawals, and withdrawable astrologer earnings',
  })
  summary(@CurrentUser() user: User) {
    return this.withdrawals.summary(user);
  }

  @Post('withdrawals')
  @ApiOperation({
    summary:
      'Request a withdrawal. Reserves funds for admin review; does not transfer money.',
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
    );
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'Paginated own withdrawal history' })
  list(@CurrentUser() user: User, @Query() query: WithdrawalListQueryDto) {
    return this.withdrawals.listMine(user, query);
  }

  @Get('withdrawals/:id')
  @ApiOperation({ summary: 'Own withdrawal detail (masked destination)' })
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.withdrawals.getMine(user, id);
  }
}

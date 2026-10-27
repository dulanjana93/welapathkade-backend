import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EarningsLedgerQueryDto } from './dto/earnings-ledger-query.dto';
import { EarningsService } from './earnings.service';

@ApiTags('Earnings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PUBLIC, UserRole.ASTROLOGER)
@Controller('me/earnings')
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Own wallet available balance and ledger totals (internal balance, not a payout)',
  })
  summary(@CurrentUser() user: User) {
    return this.earnings.summary(user);
  }

  @Get('ledger')
  @ApiOperation({
    summary: 'Own paginated ledger history (excludes platform residual)',
  })
  ledger(@CurrentUser() user: User, @Query() query: EarningsLedgerQueryDto) {
    return this.earnings.listLedger(user, query);
  }
}

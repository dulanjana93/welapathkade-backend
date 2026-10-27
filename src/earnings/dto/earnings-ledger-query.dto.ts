import { ApiPropertyOptional } from '@nestjs/swagger';
import { LedgerCategory } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Categories visible on authenticated user earnings (never platform residual). */
export const USER_EARNINGS_CATEGORIES: LedgerCategory[] = [
  LedgerCategory.ASTROLOGER_EARNING,
  LedgerCategory.CUSTOMER_REFERRAL,
  LedgerCategory.ASTROLOGER_REFERRAL,
];

export class EarningsLedgerQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 20;

  @ApiPropertyOptional({ enum: USER_EARNINGS_CATEGORIES })
  @IsOptional()
  @IsEnum(LedgerCategory)
  category?: LedgerCategory;
}

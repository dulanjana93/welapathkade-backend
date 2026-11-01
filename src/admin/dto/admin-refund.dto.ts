import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayHereRefundStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export class AdminRefundQueryDto {
  @ApiPropertyOptional({
    enum: PayHereRefundStatus,
    description:
      'Filter by internal refund status. This is the PayHere refund attempt, not the refund obligation and not a ledger reversal.',
  })
  @IsOptional()
  @IsEnum(PayHereRefundStatus)
  status?: PayHereRefundStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

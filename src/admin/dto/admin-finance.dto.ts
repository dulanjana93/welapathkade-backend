import { ApiPropertyOptional } from '@nestjs/swagger';
import { LedgerCategory, LedgerEntryKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Shared UTC half-open interval query: from <= timestamp < to. */
export class FinanceDateRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Inclusive UTC start (ISO-8601). Half-open with `to`.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Exclusive UTC end (ISO-8601). Half-open with `from`.',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class FinancePaginationQueryDto extends FinanceDateRangeQueryDto {
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

export class AdminLedgerQueryDto extends FinancePaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  appointmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  paymentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  snapshotId?: string;

  @ApiPropertyOptional({ enum: LedgerCategory })
  @IsOptional()
  @IsEnum(LedgerCategory)
  category?: LedgerCategory;

  @ApiPropertyOptional({ enum: LedgerEntryKind })
  @IsOptional()
  @IsEnum(LedgerEntryKind)
  kind?: LedgerEntryKind;
}

export class AdminAttentionCasesQueryDto extends FinancePaginationQueryDto {}

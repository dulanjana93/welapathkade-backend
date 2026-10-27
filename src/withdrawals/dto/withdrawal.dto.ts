import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WithdrawalPurpose, WithdrawalStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FinancePaginationQueryDto } from '../../admin/dto/admin-finance.dto';

const NAME = /^[\p{L}\p{N} .,&'()/-]{2,120}$/u;
const CODE = /^[A-Za-z0-9-]{2,32}$/;
const ACCOUNT = /^\d{6,20}$/;
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export class CreateBankAccountDto {
  @ApiProperty()
  @IsString()
  @Matches(NAME)
  bankName!: string;

  @ApiProperty()
  @IsString()
  @Matches(NAME)
  accountHolderName!: string;

  @ApiProperty()
  @IsString()
  @Matches(NAME)
  branchName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(CODE)
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(CODE)
  branchCode?: string;

  @ApiProperty({
    description: 'Digits only. Stored encrypted; never returned.',
  })
  @IsString()
  @Matches(ACCOUNT)
  accountNumber!: string;
}

export class UpdateBankAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(NAME)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(NAME)
  accountHolderName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(NAME)
  branchName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(CODE)
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(CODE)
  branchCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ACCOUNT)
  accountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateWithdrawalDto {
  @ApiProperty({ example: '1000.00' })
  @IsString()
  @Matches(AMOUNT)
  amount!: string;

  @ApiPropertyOptional({ enum: ['LKR'] })
  @IsOptional()
  @IsIn(['LKR'])
  currency?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  bankAccountId!: string;
}

export class WithdrawalListQueryDto {
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

  @ApiPropertyOptional({ enum: WithdrawalStatus })
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;
}

export class RejectWithdrawalDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class CancelWithdrawalDto {
  @ApiProperty({
    description:
      'Why this approved request cannot be paid. Trimmed; 3–500 characters.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class MarkWithdrawalPaidDto {
  @ApiProperty({
    description: 'Bank transfer reference confirmed by the admin',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,63}$/)
  transferReference!: string;

  @ApiProperty({
    description: 'When the bank transfer actually occurred (ISO-8601)',
  })
  @IsString()
  @IsNotEmpty()
  actualTransferredAt!: string;
}

export class AdminWithdrawalQueryDto extends FinancePaginationQueryDto {
  @ApiPropertyOptional({ enum: WithdrawalStatus })
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    enum: WithdrawalPurpose,
    description:
      'Defaults to ASTROLOGER_EARNINGS so the astrologer withdrawal list stays unchanged.',
  })
  @IsOptional()
  @IsEnum(WithdrawalPurpose)
  purpose?: WithdrawalPurpose;
}

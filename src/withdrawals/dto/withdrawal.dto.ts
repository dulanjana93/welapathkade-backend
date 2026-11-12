import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WithdrawalPurpose, WithdrawalStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
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

export class RevealWithdrawalDestinationDto {
  @ApiProperty({
    description: 'Admin account password re-entry required to reveal destination',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Mandatory reason for revealing the frozen destination account number',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** Swagger success schema — never documents ciphertext, IV, tag, or key material. */
export class RevealWithdrawalDestinationResponseDto {
  @ApiProperty()
  withdrawalId!: string;

  @ApiProperty({ enum: WithdrawalStatus, example: WithdrawalStatus.APPROVED })
  status!: WithdrawalStatus;

  @ApiProperty({ enum: WithdrawalPurpose })
  purpose!: WithdrawalPurpose;

  @ApiProperty({
    type: 'object',
    properties: {
      bankName: { type: 'string' },
      accountHolderName: { type: 'string' },
      branchName: { type: 'string' },
      bankCode: { type: 'string', nullable: true },
      branchCode: { type: 'string', nullable: true },
      accountNumber: {
        type: 'string',
        description: 'Full account number from the frozen withdrawal snapshot',
      },
      accountNumberMasked: { type: 'string', example: '••••9012' },
    },
  })
  destination!: {
    bankName: string;
    accountHolderName: string;
    branchName: string;
    bankCode: string | null;
    branchCode: string | null;
    accountNumber: string;
    accountNumberMasked: string;
  };

  @ApiProperty({ description: 'ISO-8601 timestamp when plaintext was returned' })
  revealedAt!: string;

  @ApiProperty()
  auditLogId!: string;
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

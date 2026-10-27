import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CorrectReferralAttributionDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'PUBLIC referrer user id, or null to clear an incorrect attribution',
  })
  @IsDefined()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @IsNotEmpty()
  referrerUserId!: string | null;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Mandatory reason for the admin correction',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

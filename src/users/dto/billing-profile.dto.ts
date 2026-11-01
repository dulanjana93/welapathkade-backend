import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BILLING_LIMITS, collapseWhitespace } from '../billing-profile';

function trimCollapsed({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? collapseWhitespace(value) : value;
}

export class UpsertBillingProfileDto {
  @ApiProperty({ example: 'Nimal', maxLength: BILLING_LIMITS.name })
  @Transform(trimCollapsed)
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(BILLING_LIMITS.name)
  firstName!: string;

  @ApiProperty({ example: 'Perera', maxLength: BILLING_LIMITS.name })
  @Transform(trimCollapsed)
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(BILLING_LIMITS.name)
  lastName!: string;

  @ApiProperty({ example: 'nimal@example.com', maxLength: BILLING_LIMITS.email })
  @Transform(trimCollapsed)
  @IsEmail()
  @MaxLength(BILLING_LIMITS.email)
  email!: string;

  @ApiProperty({
    example: '12 Temple Road',
    maxLength: BILLING_LIMITS.address,
  })
  @Transform(trimCollapsed)
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(BILLING_LIMITS.address)
  address!: string;

  @ApiProperty({ example: 'Colombo', maxLength: BILLING_LIMITS.city })
  @Transform(trimCollapsed)
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(BILLING_LIMITS.city)
  city!: string;

  @ApiProperty({
    example: 'Sri Lanka',
    description:
      'Country name, or a two-letter ISO code. Two-letter values are stored in uppercase.',
    maxLength: BILLING_LIMITS.country,
  })
  @Transform(trimCollapsed)
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(BILLING_LIMITS.country)
  country!: string;
}

export class BillingProfileResponseDto {
  @ApiProperty({ nullable: true, example: 'Nimal' })
  firstName!: string | null;

  @ApiProperty({ nullable: true, example: 'Perera' })
  lastName!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Billing email. This is not the admin login email.',
    example: 'nimal@example.com',
  })
  email!: string | null;

  @ApiProperty({
    description: 'Phone number already stored on the customer account.',
    example: '+94771234567',
  })
  phone!: string;

  @ApiProperty({ nullable: true, example: '12 Temple Road' })
  address!: string | null;

  @ApiProperty({ nullable: true, example: 'Colombo' })
  city!: string | null;

  @ApiProperty({ nullable: true, example: 'Sri Lanka' })
  country!: string | null;

  @ApiProperty({
    description:
      'True only when first name, last name, email, account phone, address, city, and country are all present and valid.',
  })
  complete!: boolean;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      'Field names that are missing or invalid. Empty when complete is true.',
  })
  missingFields!: string[];
}

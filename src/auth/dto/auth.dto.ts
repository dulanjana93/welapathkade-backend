import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language, OtpPurpose } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({ example: '+94771234567' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiPropertyOptional({ enum: OtpPurpose })
  @IsOptional()
  @IsEnum(OtpPurpose)
  purpose?: OtpPurpose;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+94771234567' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(4, 8)
  @Matches(/^\d+$/)
  code!: string;

  @ApiPropertyOptional({ description: 'Required for new user registration' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: Language })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({
    description: 'Referral code of an existing PUBLIC user (registration only)',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  referralCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fcmToken?: string;

  @ApiPropertyOptional({ enum: ['IOS', 'ANDROID', 'WEB'] })
  @IsOptional()
  @IsEnum(['IOS', 'ANDROID', 'WEB'] as const)
  platform?: 'IOS' | 'ANDROID' | 'WEB';
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class RegisterDeviceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  fcmToken!: string;

  @ApiProperty({ enum: ['IOS', 'ANDROID', 'WEB'] })
  @IsEnum(['IOS', 'ANDROID', 'WEB'] as const)
  platform!: 'IOS' | 'ANDROID' | 'WEB';
}

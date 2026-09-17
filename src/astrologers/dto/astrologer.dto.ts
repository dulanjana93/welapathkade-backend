import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AstrologerServiceStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAstrologerProfileDto {
  @ApiProperty({ example: 'Nimal Perera' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  experienceYears?: number;

  @ApiPropertyOptional({ description: 'Photo URL or file key (files module later)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  photo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;
}

export class UpdateAstrologerProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  experienceYears?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  photo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;
}

export class AssignAstrologerServiceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  serviceId!: string;

  @ApiProperty({ example: 1500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;
}

export class UpdateAstrologerServiceDto {
  @ApiPropertyOptional({ example: 1800 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ enum: AstrologerServiceStatus })
  @IsOptional()
  @IsEnum(AstrologerServiceStatus)
  status?: AstrologerServiceStatus;
}

export class UpdateAstrologerStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] })
  @IsEnum(['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const)
  status!: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}

export class ReviewAstrologerApplicationDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsEnum(['APPROVE', 'REJECT'] as const)
  action!: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({
    description: 'Required when action is REJECT',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  rejectionReason?: string;
}


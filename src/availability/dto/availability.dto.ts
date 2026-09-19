import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvailabilityExceptionType, DayOfWeek } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class WeeklyWindowInputDto {
  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiProperty({ example: '12:00' })
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime!: string;
}

export class PutWeeklyAvailabilityDto {
  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  monday?: WeeklyWindowInputDto[];

  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  tuesday?: WeeklyWindowInputDto[];

  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  wednesday?: WeeklyWindowInputDto[];

  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  thursday?: WeeklyWindowInputDto[];

  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  friday?: WeeklyWindowInputDto[];

  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  saturday?: WeeklyWindowInputDto[];

  @ApiPropertyOptional({ type: [WeeklyWindowInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowInputDto)
  @ArrayMaxSize(12)
  sunday?: WeeklyWindowInputDto[];
}

export class CreateAvailabilityExceptionDto {
  @ApiProperty({ example: '2026-09-25' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiProperty({ enum: AvailabilityExceptionType })
  @IsEnum(AvailabilityExceptionType)
  type!: AvailabilityExceptionType;

  @ApiPropertyOptional({ example: '14:00' })
  @ValidateIf((o: CreateAvailabilityExceptionDto) =>
    o.type === AvailabilityExceptionType.AVAILABLE_OVERRIDE,
  )
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @ValidateIf((o: CreateAvailabilityExceptionDto) =>
    o.type === AvailabilityExceptionType.AVAILABLE_OVERRIDE,
  )
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateAvailabilityExceptionDto {
  @ApiPropertyOptional({ enum: AvailabilityExceptionType })
  @IsOptional()
  @IsEnum(AvailabilityExceptionType)
  type?: AvailabilityExceptionType;

  @ApiPropertyOptional({ example: '14:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string | null;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export { DayOfWeek, AvailabilityExceptionType };

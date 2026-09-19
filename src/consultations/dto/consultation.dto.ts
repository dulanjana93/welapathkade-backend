import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationStatus, ConsultationFileType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ConsultationFileAttachmentDto {
  @ApiProperty({ description: 'Existing File.id owned by the customer' })
  @IsString()
  @IsNotEmpty()
  fileId!: string;

  @ApiProperty({ enum: ConsultationFileType })
  @IsEnum(ConsultationFileType)
  type!: ConsultationFileType;
}

export class CreateConsultationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  astrologerId!: string;

  @ApiProperty({ description: 'Platform service id offered by the astrologer' })
  @IsString()
  @IsNotEmpty()
  serviceId!: string;

  @ApiProperty({
    description:
      'Preferred start as ISO-8601 instant (UTC). Customer UI uses Asia/Colombo; API stores UTC. Not an appointment time.',
    example: '2026-09-20T04:30:00.000Z',
  })
  @IsDateString()
  preferredStartAt!: string;

  @ApiPropertyOptional({
    description:
      'Optional preferred end (ISO-8601 UTC). Preference only — does not set final appointment duration.',
  })
  @IsOptional()
  @IsDateString()
  preferredEndAt?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  @ApiPropertyOptional({
    type: [ConsultationFileAttachmentDto],
    description:
      'Optional kundali/voice file metadata refs (private). No public URLs.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConsultationFileAttachmentDto)
  files?: ConsultationFileAttachmentDto[];
}

export class ListConsultationsQueryDto {
  @ApiPropertyOptional({ enum: ConsultationStatus })
  @IsOptional()
  @IsEnum(ConsultationStatus)
  status?: ConsultationStatus;
}

export class DeclineConsultationDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

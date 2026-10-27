import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ASTROLOGER_SUMMARY_MAX_LENGTH,
  FOLLOW_UP_MESSAGE_MAX_LENGTH,
} from '../consultation-follow-up.constants';

export class SendFollowUpMessageDto {
  @ApiProperty({
    description: 'Plain-text follow-up message body',
    maxLength: FOLLOW_UP_MESSAGE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FOLLOW_UP_MESSAGE_MAX_LENGTH)
  body!: string;
}

export class UpsertAstrologerSummaryDto {
  @ApiPropertyOptional({
    description:
      'Plain-text astrologer summary. Omit or send empty/whitespace to clear.',
    maxLength: ASTROLOGER_SUMMARY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ASTROLOGER_SUMMARY_MAX_LENGTH)
  summary?: string;
}

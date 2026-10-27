import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  REVIEW_BODY_MAX_LENGTH,
  REVIEW_LIST_DEFAULT_LIMIT,
  REVIEW_LIST_MAX_LIMIT,
  REVIEW_RATING_MAX,
  REVIEW_RATING_MIN,
} from '../consultation-review.constants';

export class UpsertConsultationReviewDto {
  @ApiProperty({
    minimum: REVIEW_RATING_MIN,
    maximum: REVIEW_RATING_MAX,
    description: 'Integer star rating from 1 to 5',
  })
  @Type(() => Number)
  @IsInt()
  @Min(REVIEW_RATING_MIN)
  @Max(REVIEW_RATING_MAX)
  rating!: number;

  @ApiPropertyOptional({
    maxLength: REVIEW_BODY_MAX_LENGTH,
    description: 'Optional plain-text review. Empty/whitespace clears text.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_BODY_MAX_LENGTH)
  body?: string;
}

export class ListAstrologerReviewsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: '1-based page index',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: REVIEW_LIST_MAX_LIMIT,
    default: REVIEW_LIST_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REVIEW_LIST_MAX_LIMIT)
  limit?: number = REVIEW_LIST_DEFAULT_LIMIT;
}

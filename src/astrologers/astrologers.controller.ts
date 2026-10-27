import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ListAstrologerReviewsQueryDto } from '../consultations/dto/review.dto';
import { AstrologersService } from './astrologers.service';

class ListAstrologersQueryDto {
  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxPrice?: number;
}

@ApiTags('Astrologers')
@Controller('astrologers')
export class AstrologersController {
  constructor(private readonly astrologersService: AstrologersService) {}

  @Get()
  @ApiOperation({
    summary: 'Discover publicly listed active astrologers',
  })
  @ApiQuery({ name: 'serviceId', required: false })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  @ApiOkResponse({ description: 'Public astrologer cards (no private fields)' })
  list(@Query() query: ListAstrologersQueryDto) {
    return this.astrologersService.listDiscoverable({
      serviceId: query.serviceId,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
    });
  }

  @Get(':id/reviews')
  @ApiOperation({
    summary:
      'List public privacy-safe reviews for an astrologer (newest first, paginated)',
  })
  listReviews(
    @Param('id') id: string,
    @Query() query: ListAstrologerReviewsQueryDto,
  ) {
    return this.astrologersService.listPublicReviews(
      id,
      query.page,
      query.limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a publicly discoverable astrologer profile' })
  get(@Param('id') id: string) {
    return this.astrologersService.getDiscoverableById(id);
  }
}

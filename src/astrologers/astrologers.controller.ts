import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ListAstrologerReviewsQueryDto } from '../consultations/dto/review.dto';
import { ProfilePicturesService } from '../profile-pictures/profile-pictures.service';
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
  constructor(
    private readonly astrologersService: AstrologersService,
    private readonly pictures: ProfilePicturesService,
  ) {}

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

  @Get(':id/profile-picture')
  @Header('Cache-Control', 'private, max-age=60')
  @ApiOperation({
    summary:
      'Stream a discoverable astrologer profile picture. The storage bucket stays private.',
  })
  async profilePicture(@Param('id') id: string) {
    const file = await this.pictures.openDiscoverableAstrologer(id);
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: 'inline; filename="profile"',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a publicly discoverable astrologer profile' })
  get(@Param('id') id: string) {
    return this.astrologersService.getDiscoverableById(id);
  }
}

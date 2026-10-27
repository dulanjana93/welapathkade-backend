import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';

@ApiTags('Astrologers')
@Controller('astrologers')
export class AvailabilityPublicController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Get(':id/availability')
  @ApiOperation({
    summary: 'Public weekly availability for an ACTIVE astrologer',
  })
  getPublic(@Param('id') id: string) {
    return this.availabilityService.getPublicAvailability(id);
  }

  @Get(':id/availability/slots')
  @ApiOperation({
    summary:
      'Public bookable slots (lead time, horizon, and occupancy: confirmed appointments, live payment holds, accepted proposals)',
  })
  @ApiQuery({ name: 'from', required: true, example: '2026-09-20' })
  @ApiQuery({ name: 'to', required: true, example: '2026-09-27' })
  @ApiQuery({ name: 'durationMinutes', required: false, example: 30 })
  getSlots(
    @Param('id') id: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('durationMinutes') durationMinutes?: string,
  ) {
    return this.availabilityService.getPublicSlots(id, {
      from,
      to,
      durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
    });
  }
}

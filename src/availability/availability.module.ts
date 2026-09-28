import { Module } from '@nestjs/common';
import { AvailabilityCalculator } from './availability.calculator';
import { AvailabilityMeController } from './availability-me.controller';
import { AvailabilityPublicController } from './availability-public.controller';
import { AvailabilityService } from './availability.service';
import { BookingGuardService } from './booking-guard.service';
import { OccupancyService } from './occupancy.service';

@Module({
  controllers: [AvailabilityMeController, AvailabilityPublicController],
  providers: [
    AvailabilityService,
    AvailabilityCalculator,
    BookingGuardService,
    OccupancyService,
  ],
  exports: [
    AvailabilityService,
    AvailabilityCalculator,
    BookingGuardService,
    OccupancyService,
  ],
})
export class AvailabilityModule {}

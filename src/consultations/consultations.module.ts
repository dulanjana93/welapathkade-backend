import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { AstrologerConsultationsController } from './astrologer-consultations.controller';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

@Module({
  imports: [AvailabilityModule],
  controllers: [ConsultationsController, AstrologerConsultationsController],
  providers: [ConsultationsService, ConsultationProposalsService],
  exports: [ConsultationsService, ConsultationProposalsService],
})
export class ConsultationsModule {}

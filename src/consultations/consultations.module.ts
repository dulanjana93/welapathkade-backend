import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { AstrologerConsultationsController } from './astrologer-consultations.controller';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

@Module({
  imports: [AvailabilityModule, PaymentsModule, NotificationsModule],
  controllers: [ConsultationsController, AstrologerConsultationsController],
  providers: [ConsultationsService, ConsultationProposalsService],
  exports: [ConsultationsService, ConsultationProposalsService],
})
export class ConsultationsModule {}

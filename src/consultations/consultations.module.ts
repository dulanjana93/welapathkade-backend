import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { StorageModule } from '../storage/storage.module';
import { VideoModule } from '../video/video.module';
import { AstrologerConsultationsController } from './astrologer-consultations.controller';
import { ConsultationAttachmentsService } from './consultation-attachments.service';
import { ConsultationFollowUpService } from './consultation-follow-up.service';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationReviewsService } from './consultation-reviews.service';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

@Module({
  imports: [
    AvailabilityModule,
    PaymentsModule,
    NotificationsModule,
    VideoModule,
    StorageModule,
  ],
  controllers: [ConsultationsController, AstrologerConsultationsController],
  providers: [
    ConsultationsService,
    ConsultationAttachmentsService,
    ConsultationProposalsService,
    ConsultationFollowUpService,
    ConsultationReviewsService,
  ],
  exports: [
    ConsultationsService,
    ConsultationAttachmentsService,
    ConsultationProposalsService,
    ConsultationFollowUpService,
    ConsultationReviewsService,
  ],
})
export class ConsultationsModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderAdapterBoundary } from './provider-adapter.boundary';
import {
  FailClosedRoomAppointmentMappingResolver,
  RoomAppointmentMappingResolver,
} from './room-mapping';
import { SessionEvidenceService } from './session-evidence.service';

/**
 * B3-a session attendance evidence foundation.
 *
 * Exports the recorder and fail-closed provider boundary only.
 * Does not export mint helpers or a public HTTP controller.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    SessionEvidenceService,
    ProviderAdapterBoundary,
    {
      provide: RoomAppointmentMappingResolver,
      useClass: FailClosedRoomAppointmentMappingResolver,
    },
  ],
  exports: [
    SessionEvidenceService,
    ProviderAdapterBoundary,
    RoomAppointmentMappingResolver,
  ],
})
export class SessionEvidenceModule {}

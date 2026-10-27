import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AttendanceEventDraft } from './attendance-event.contract';
import { isSessionEvidenceProviderAuthImplemented } from './capability';
import { RoomAppointmentMappingResolver } from './room-mapping';
import {
  SessionEvidenceService,
  type AttendanceEvidenceRecordResult,
} from './session-evidence.service';

/**
 * Narrow integration point for a future authenticated video-session provider.
 *
 * B3-a: authentication always fails closed. No capability is minted on any
 * production path. A future adapter must verify the provider callback inside
 * this boundary and only then write a capability into the runtime registry
 * without exposing a general-purpose mint helper to the rest of the app.
 */
@Injectable()
export class ProviderAdapterBoundary {
  constructor(
    private readonly evidence: SessionEvidenceService,
    private readonly roomMapping: RoomAppointmentMappingResolver,
  ) {}

  isProviderAuthenticationImplemented(): boolean {
    return isSessionEvidenceProviderAuthImplemented();
  }

  /**
   * Authenticate a provider callback. Always fails closed until a real
   * provider adapter replaces this implementation.
   */
  async authenticateProviderCallback(_input: {
    provider: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<never> {
    throw new ServiceUnavailableException(
      'No video session provider authenticator is registered. ' +
        'Trusted attendance evidence cannot be accepted until a provider ' +
        'adapter supplies authentication and room/participant mapping.',
    );
  }

  /**
   * Resolve a provider room to an appointment. Fail-closed with no mappings.
   */
  async resolveAppointmentForRoom(
    provider: string,
    providerRoomId: string,
  ): Promise<string> {
    return this.roomMapping.resolveAppointmentId(provider, providerRoomId);
  }

  /**
   * Submit a normalized attendance event after successful authentication.
   *
   * Always fails closed in B3-a. When a real authenticator exists, this method
   * must: authenticate → mint capability privately → record via
   * SessionEvidenceService (which resolves appointmentId from room mapping).
   */
  async submitAuthenticatedAttendanceEvent(_input: {
    adapterName: string;
    event: AttendanceEventDraft;
  }): Promise<AttendanceEvidenceRecordResult> {
    // Reference injected deps so a future success path cannot drop them.
    void this.evidence;
    void this.roomMapping;
    throw new ServiceUnavailableException(
      'Provider authentication is not implemented; cannot submit trusted attendance evidence',
    );
  }
}

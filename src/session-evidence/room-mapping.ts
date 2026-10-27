import { Injectable, NotFoundException } from '@nestjs/common';

/**
 * Server-side mapping from a provider room/session id to an appointment.
 *
 * B3-a ships with a fail-closed resolver: no mappings exist until a future
 * provider adapter registers them after authenticating provider callbacks.
 * Guesswork is forbidden — unknown rooms never attach to a different appointment.
 */
export abstract class RoomAppointmentMappingResolver {
  abstract resolveAppointmentId(
    provider: string,
    providerRoomId: string,
  ): Promise<string>;
}

@Injectable()
export class FailClosedRoomAppointmentMappingResolver extends RoomAppointmentMappingResolver {
  async resolveAppointmentId(
    provider: string,
    providerRoomId: string,
  ): Promise<string> {
    throw new NotFoundException(
      `No appointment mapping for provider room (provider=${provider}, room present=${providerRoomId.length > 0})`,
    );
  }
}

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SessionEvidenceCapability } from '../../src/session-evidence/capability';
import { RoomAppointmentMappingResolver } from '../../src/session-evidence/room-mapping';

/**
 * Test-only session-evidence doubles (not part of the Nest production build).
 *
 * Jest unit/e2e setup maps `src/session-evidence/capability` to
 * `sessionEvidenceCapabilityJestModule` so assert + mint share one WeakSet
 * that never ships in `dist`.
 */
const liveCapabilities = new WeakSet<object>();

export function assertSessionEvidenceCapabilityForTests(
  capability: SessionEvidenceCapability,
): void {
  if (!capability || !liveCapabilities.has(capability)) {
    throw new ForbiddenException(
      'A live session-evidence capability is required. ' +
        'Type casts and unauthenticated callers are rejected.',
    );
  }
}

export function createTestSessionEvidenceCapability(): SessionEvidenceCapability {
  const capability = {
    source: 'TEST_HARNESS' as const,
  } as SessionEvidenceCapability;
  liveCapabilities.add(capability);
  return capability;
}

/** Mirrors production internal mint against the Jest WeakSet. */
export function mintInternalSessionLifecycleCapabilityForTests(): SessionEvidenceCapability {
  const capability = {
    source: 'INTERNAL_LIFECYCLE' as const,
  } as SessionEvidenceCapability;
  liveCapabilities.add(capability);
  return capability;
}

export function isSessionEvidenceProviderAuthImplementedForTests(): boolean {
  return false;
}

/** Shape returned when Jest replaces `src/session-evidence/capability`. */
export const sessionEvidenceCapabilityJestModule = {
  assertSessionEvidenceCapability: assertSessionEvidenceCapabilityForTests,
  mintInternalSessionLifecycleCapability:
    mintInternalSessionLifecycleCapabilityForTests,
  isSessionEvidenceProviderAuthImplemented:
    isSessionEvidenceProviderAuthImplementedForTests,
};

/**
 * Explicit room → appointment map for tests. Production uses the fail-closed
 * resolver with zero mappings.
 */
export class TestRoomAppointmentMappingResolver extends RoomAppointmentMappingResolver {
  constructor(
    private readonly rooms:
      ReadonlyMap<string, string> | Record<string, string>,
  ) {
    super();
  }

  async resolveAppointmentId(
    provider: string,
    providerRoomId: string,
  ): Promise<string> {
    const key = `${provider}::${providerRoomId}`;
    const map =
      this.rooms instanceof Map
        ? this.rooms
        : new Map(Object.entries(this.rooms));
    const appointmentId = map.get(key);
    if (!appointmentId) {
      throw new NotFoundException(
        `No appointment mapping for provider room (provider=${provider}, room present=${providerRoomId.length > 0})`,
      );
    }
    return appointmentId;
  }
}

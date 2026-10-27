import { ForbiddenException } from '@nestjs/common';

/**
 * Runtime trust capability for session attendance / lifecycle verification.
 *
 * Production exposes exactly one mint:
 * `mintInternalSessionLifecycleCapability`, used only by trusted server
 * paths (authorized video credential issuance and the hard-end completion
 * sweep). There is no general-purpose register/unlock API and no HTTP mint.
 * Provider authentication remains fail-closed in `ProviderAdapterBoundary`.
 *
 * Tests: Jest replaces this module with
 * `test/support/session-evidence-test-harness.ts` (unit setup + e2e setup),
 * which owns a separate test-only WeakSet and mint. That harness is under
 * `test/` and is excluded from `tsconfig.build.json`.
 */
declare const capabilityBrand: unique symbol;

export type SessionEvidenceCapabilitySource =
  'TEST_HARNESS' | 'AUTHENTICATED_ADAPTER' | 'INTERNAL_LIFECYCLE';

export type SessionEvidenceCapability = {
  readonly [capabilityBrand]: true;
  readonly source: SessionEvidenceCapabilitySource;
};

const liveCapabilities = new WeakSet<object>();

export function assertSessionEvidenceCapability(
  capability: SessionEvidenceCapability,
): void {
  if (!capability || !liveCapabilities.has(capability)) {
    throw new ForbiddenException(
      'A live session-evidence capability is required. ' +
        'Type casts and unauthenticated callers are rejected.',
    );
  }
}

/**
 * Mint a process-local capability for internal session lifecycle transitions.
 *
 * Callers must be Nest services that already enforced authorization
 * (participant ownership + join window) or are the hard-end completion sweep.
 * Never expose this over HTTP or accept client-supplied capabilities.
 */
export function mintInternalSessionLifecycleCapability(): SessionEvidenceCapability {
  const capability = {
    source: 'INTERNAL_LIFECYCLE' as const,
  } as SessionEvidenceCapability;
  liveCapabilities.add(capability);
  return capability;
}

/**
 * Always false until a real provider authenticator is registered.
 * Do not treat TypeScript types as authentication.
 */
export function isSessionEvidenceProviderAuthImplemented(): boolean {
  return false;
}

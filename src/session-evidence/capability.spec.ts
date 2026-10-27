/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- requireActual return typing */
import { ForbiddenException } from '@nestjs/common';
import {
  assertSessionEvidenceCapability,
  isSessionEvidenceProviderAuthImplemented,
  mintInternalSessionLifecycleCapability,
  type SessionEvidenceCapability,
} from './capability';
import { createTestSessionEvidenceCapability } from '../../test/support/session-evidence-test-harness';

type ProductionCapabilityModule = {
  assertSessionEvidenceCapability: (
    capability: SessionEvidenceCapability,
  ) => void;
  mintInternalSessionLifecycleCapability: () => SessionEvidenceCapability;
  isSessionEvidenceProviderAuthImplemented: () => boolean;
};

function productionCapabilityModule(): ProductionCapabilityModule {
  return jest.requireActual('./capability') as ProductionCapabilityModule;
}

describe('session-evidence capability boundary', () => {
  it('reports that provider authentication is not implemented', () => {
    expect(isSessionEvidenceProviderAuthImplemented()).toBe(false);
    expect(
      productionCapabilityModule().isSessionEvidenceProviderAuthImplemented(),
    ).toBe(false);
  });

  it('accepts a harness-minted capability under the Jest test double', () => {
    const cap = createTestSessionEvidenceCapability();
    expect(() => assertSessionEvidenceCapability(cap)).not.toThrow();
  });

  it('accepts the internal lifecycle mint under the Jest test double', () => {
    const cap = mintInternalSessionLifecycleCapability();
    expect(() => assertSessionEvidenceCapability(cap)).not.toThrow();
    expect(cap.source).toBe('INTERNAL_LIFECYCLE');
  });

  it('production internal mint registers against the production WeakSet', () => {
    const actual = productionCapabilityModule();
    const cap = actual.mintInternalSessionLifecycleCapability();
    expect(() => actual.assertSessionEvidenceCapability(cap)).not.toThrow();
  });

  it('rejects a TypeScript cast against the production WeakSet (requireActual)', () => {
    const actual = productionCapabilityModule();
    const forged = {
      source: 'AUTHENTICATED_ADAPTER',
    } as SessionEvidenceCapability;
    expect(() => actual.assertSessionEvidenceCapability(forged)).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a TypeScript cast against the Jest test double', () => {
    const forged = {
      source: 'AUTHENTICATED_ADAPTER',
    } as SessionEvidenceCapability;
    expect(() => assertSessionEvidenceCapability(forged)).toThrow(
      ForbiddenException,
    );
  });

  it('production capability module exposes only the scoped internal mint', () => {
    const capability = jest.requireActual('./capability') as Record<
      string,
      unknown
    >;
    expect(capability).not.toHaveProperty('registerSessionEvidenceCapability');
    expect(capability).not.toHaveProperty('mintSessionEvidenceCapability');
    expect(capability).not.toHaveProperty('withAdapterAuthUnlock');
    expect(capability).not.toHaveProperty(
      '__jestOnlyCreateSessionEvidenceCapability',
    );
    expect(capability).not.toHaveProperty(
      'mintCapabilityAfterSuccessfulProviderAuthentication',
    );
    expect(capability).not.toHaveProperty(
      'createTestSessionEvidenceCapability',
    );
    expect(capability).toHaveProperty('assertSessionEvidenceCapability');
    expect(capability).toHaveProperty('mintInternalSessionLifecycleCapability');
    expect(capability).toHaveProperty(
      'isSessionEvidenceProviderAuthImplemented',
    );
  });

  it('does not expose a generally importable mark*Verified helper from session-events', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../payments/session-events') as Record<
      string,
      unknown
    >;
    expect(mod).not.toHaveProperty('markSessionEventVerified');
    expect(mod).not.toHaveProperty('markAttendanceVerified');
  });
});

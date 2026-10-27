import { assertTestDatabase } from '../src/common/database-safety/assert-test-database';

/**
 * E2E seam: production capability module has no mint. Tests use the harness
 * WeakSet via Jest module replacement (not shipped in dist).
 */
jest.mock('../src/session-evidence/capability', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./support/session-evidence-test-harness')
    .sessionEvidenceCapabilityJestModule;
});

/**
 * Final gate after env load: refuse the suite if not on welapathkade_test.
 * (Primary load + identity log happens in load-env-test.cjs via node -r.)
 */
beforeAll(() => {
  assertTestDatabase();
});

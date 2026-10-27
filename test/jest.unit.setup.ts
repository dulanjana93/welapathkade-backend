/**
 * Unit-test seam: replace production capability module with the test-only
 * WeakSet + mint from test/support (never emitted to dist).
 */
jest.mock('../src/session-evidence/capability', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./support/session-evidence-test-harness')
    .sessionEvidenceCapabilityJestModule;
});

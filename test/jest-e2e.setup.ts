import { assertTestDatabase } from '../src/common/database-safety/assert-test-database';

/**
 * Final gate after env load: refuse the suite if not on welapathkade_test.
 * (Primary load + identity log happens in load-env-test.cjs via node -r.)
 */
beforeAll(() => {
  assertTestDatabase();
});

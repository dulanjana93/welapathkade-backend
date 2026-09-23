import {
  assertTestDatabase,
  E2E_DATABASE_NAME,
  parseMysqlDatabaseName,
} from './assert-test-database';

describe('assertTestDatabase', () => {
  const testUrl = `mysql://welapathkade:welapathkade@localhost:3307/${E2E_DATABASE_NAME}`;
  const devUrl = 'mysql://welapathkade:welapathkade@localhost:3307/welapathkade';

  it('allows cleanup when NODE_ENV=test and database is welapathkade_test', () => {
    expect(() =>
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: testUrl,
      }),
    ).not.toThrow();
  });

  it('throws when DATABASE_URL points at development database welapathkade', () => {
    expect(() =>
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: devUrl,
      }),
    ).toThrow(
      'REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: database is not welapathkade_test',
    );
  });

  it('throws when NODE_ENV is not test', () => {
    expect(() =>
      assertTestDatabase({
        NODE_ENV: 'development',
        DATABASE_URL: testUrl,
      }),
    ).toThrow(
      'REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: NODE_ENV is not "test"',
    );
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() =>
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: undefined,
      }),
    ).toThrow(
      'REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: DATABASE_URL is missing',
    );
  });

  it('throws when DATABASE_URL is empty', () => {
    expect(() =>
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: '   ',
      }),
    ).toThrow(
      'REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: DATABASE_URL is missing',
    );
  });

  it('parses database name from mysql URL', () => {
    expect(parseMysqlDatabaseName(testUrl)).toBe(E2E_DATABASE_NAME);
    expect(parseMysqlDatabaseName(devUrl)).toBe('welapathkade');
  });
});

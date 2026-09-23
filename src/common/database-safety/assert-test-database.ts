/**
 * Hard safety gate for destructive E2E cleanup.
 *
 * E2E must ONLY ever run against database name: welapathkade_test
 * Never against development database: welapathkade
 */

export const E2E_DATABASE_NAME = 'welapathkade_test';
export const DEVELOPMENT_DATABASE_NAME = 'welapathkade';

export type EnvLike = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
};

/**
 * Parse MySQL database name from a Prisma/MySQL connection URL.
 * Returns null if the URL is missing or unparseable.
 */
export function parseMysqlDatabaseName(
  databaseUrl: string | undefined | null,
): string | null {
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    return null;
  }
  const trimmed = databaseUrl.trim();
  if (!trimmed) return null;

  try {
    const normalized = trimmed.replace(/^mysql:/i, 'http:');
    const url = new URL(normalized);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return name || null;
  } catch {
    const match = trimmed.match(/\/([^/?]+)(\?|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

export function parseMysqlHostPort(databaseUrl: string | undefined | null): {
  host: string | null;
  port: string | null;
} {
  if (!databaseUrl) return { host: null, port: null };
  try {
    const normalized = databaseUrl.trim().replace(/^mysql:/i, 'http:');
    const url = new URL(normalized);
    return {
      host: url.hostname || null,
      port: url.port || null,
    };
  } catch {
    return { host: null, port: null };
  }
}

/**
 * Throws if the process is not clearly configured for the isolated E2E database.
 * Call this before ANY deleteMany / truncate / destructive cleanup.
 */
export function assertTestDatabase(env: EnvLike = process.env): void {
  const nodeEnv = env.NODE_ENV;
  const databaseUrl = env.DATABASE_URL;

  if (nodeEnv !== 'test') {
    throw new Error(
      'REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: NODE_ENV is not "test"',
    );
  }

  if (!databaseUrl || !databaseUrl.trim()) {
    throw new Error(
      'REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: DATABASE_URL is missing',
    );
  }

  const databaseName = parseMysqlDatabaseName(databaseUrl);
  if (databaseName !== E2E_DATABASE_NAME) {
    throw new Error(
      `REFUSING TO RUN DESTRUCTIVE TEST CLEANUP: database is not ${E2E_DATABASE_NAME} (got "${databaseName ?? 'unknown'}")`,
    );
  }
}

/** Redacted identity for startup logs — never includes credentials. */
export function describeDatabaseIdentity(
  databaseUrl: string | undefined | null = process.env.DATABASE_URL,
): string {
  const { host, port } = parseMysqlHostPort(databaseUrl);
  const database = parseMysqlDatabaseName(databaseUrl);
  return `host=${host ?? '?'}\nport=${port ?? '?'}\ndatabase=${database ?? '?'}`;
}

/**
 * Fail-closed runtime safety rules.
 *
 * Development-only integrations (mock payments, console SMS/push, Swagger,
 * localhost CORS defaults) are allowed ONLY when NODE_ENV is explicitly
 * `development` or `test`. An unset, misspelled or unknown NODE_ENV is treated
 * as production, so a missing variable can never silently enable them.
 */
const NON_PRODUCTION_ENVS: readonly string[] = ['development', 'test'];

export function isNonProductionEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && NON_PRODUCTION_ENVS.includes(nodeEnv);
}

/**
 * Throws unless a development-only implementation may run in this
 * environment. Called from the provider factory that selects the
 * implementation, so the application refuses to boot.
 */
export function assertDevOnlyProviderAllowed(
  slot: string,
  implementation: string,
  nodeEnv: string | undefined,
): void {
  if (isNonProductionEnv(nodeEnv)) return;
  throw new Error(
    `Unsafe configuration: ${implementation} is a development-only ${slot} ` +
      `and cannot be used when NODE_ENV is ${
        nodeEnv === undefined ? 'unset' : JSON.stringify(nodeEnv)
      }. Configure a production ${slot} before deploying.`,
  );
}

/**
 * Push providers: `console` logs notification content and is development-only.
 * `noop` is harmless (it delivers nothing) and stays allowed so notification
 * rows are still recorded; the caller should warn that nothing is delivered.
 */
export function assertFcmProviderAllowed(
  kind: 'console' | 'noop',
  nodeEnv: string | undefined,
): { warnNoDelivery: boolean } {
  if (kind === 'console') {
    assertDevOnlyProviderAllowed(
      'push notification provider',
      'ConsoleFcmProvider',
      nodeEnv,
    );
    return { warnNoDelivery: false };
  }
  return { warnNoDelivery: !isNonProductionEnv(nodeEnv) };
}

const DEFAULT_DEV_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

/**
 * CORS origins. Development/test fall back to localhost defaults. Anywhere
 * else CORS_ORIGINS must be set explicitly, must not contain a wildcard
 * (credentials are enabled) and must not point at localhost.
 */
export function resolveCorsOrigins(
  raw: string | undefined,
  nodeEnv: string | undefined,
): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (isNonProductionEnv(nodeEnv)) {
    return parsed.length > 0 ? parsed : DEFAULT_DEV_CORS_ORIGINS;
  }

  if (parsed.length === 0) {
    throw new Error(
      'Unsafe configuration: CORS_ORIGINS must be set explicitly when NODE_ENV is not development/test.',
    );
  }
  for (const origin of parsed) {
    if (origin === '*' || origin.includes('*')) {
      throw new Error(
        'Unsafe configuration: CORS_ORIGINS must not contain wildcards (credentials are enabled).',
      );
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(origin)) {
      throw new Error(
        `Unsafe configuration: CORS_ORIGINS contains a local origin (${origin}) outside development/test.`,
      );
    }
  }
  return parsed;
}

/** Swagger UI is exposed only in development/test. */
export function isSwaggerEnabled(nodeEnv: string | undefined): boolean {
  return isNonProductionEnv(nodeEnv);
}

/** Mock gateway callbacks are accepted only in development/test. */
export function isMockPaymentCallbackAllowed(
  nodeEnv: string | undefined,
): boolean {
  return isNonProductionEnv(nodeEnv);
}

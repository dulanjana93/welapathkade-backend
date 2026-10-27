import 'reflect-metadata';
import { resolveFcmProviderKind } from '../notifications/fcm-provider.interface';
import { validateEnv } from './validate-env';

const baseEnv = {
  NODE_ENV: 'development',
  PORT: '3010',
  DATABASE_URL: 'mysql://user:pass@localhost:3306/none',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-access',
  JWT_REFRESH_SECRET: 'test-refresh',
  BUSINESS_TIMEZONE: 'Asia/Colombo',
  BANK_ACCOUNT_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
};

describe('validateEnv: NODE_ENV', () => {
  it('is required: an unset NODE_ENV fails startup instead of defaulting to development', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: undefined })).toThrow(
      /Environment validation failed/,
    );
  });

  it.each(['development', 'test', 'production'])('accepts %s', (env) => {
    expect(validateEnv({ ...baseEnv, NODE_ENV: env }).NODE_ENV).toBe(env);
  });

  it.each(['staging', 'prod', 'Production', ''])('rejects %j', (env) => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: env })).toThrow(
      /Environment validation failed/,
    );
  });
});

describe('validateEnv: NOTIFICATIONS_FCM_PROVIDER', () => {
  it('is optional: startup validation passes when it is absent', () => {
    expect(() => validateEnv({ ...baseEnv })).not.toThrow();
  });

  it.each([
    ['console', 'console'],
    ['noop', 'noop'],
    ['Console', 'console'],
    ['NOOP', 'noop'],
    ['  console  ', 'console'],
    ['\tNoOp\n', 'noop'],
  ])('accepts %j and normalizes it to %s', (raw, expected) => {
    const env = validateEnv({ ...baseEnv, NOTIFICATIONS_FCM_PROVIDER: raw });
    expect(env.NOTIFICATIONS_FCM_PROVIDER).toBe(expected);
  });

  it.each(['', '   ', '\t'])('treats %j as unset', (raw) => {
    const env = validateEnv({ ...baseEnv, NOTIFICATIONS_FCM_PROVIDER: raw });
    expect(env.NOTIFICATIONS_FCM_PROVIDER).toBeUndefined();
  });

  it.each(['firebase', 'fcm', 'console noop', 'true'])(
    'rejects unsupported value %j',
    (raw) => {
      expect(() =>
        validateEnv({ ...baseEnv, NOTIFICATIONS_FCM_PROVIDER: raw }),
      ).toThrow(/Environment validation failed/);
    },
  );

  it('does not weaken validation of the existing required variables', () => {
    expect(() => validateEnv({ ...baseEnv, DATABASE_URL: undefined })).toThrow(
      /Environment validation failed/,
    );
  });
});

describe('validation and runtime selection agree', () => {
  it.each(['Console', '  NOOP ', 'console'])(
    'a value accepted by validation (%j) selects the same provider at runtime',
    (raw) => {
      const validated = validateEnv({
        ...baseEnv,
        NOTIFICATIONS_FCM_PROVIDER: raw,
      }).NOTIFICATIONS_FCM_PROVIDER;
      expect(resolveFcmProviderKind(raw, 'production')).toBe(
        resolveFcmProviderKind(validated, 'production'),
      );
      expect(resolveFcmProviderKind(raw, 'production')).toBe(
        raw.trim().toLowerCase(),
      );
    },
  );

  it('keeps the defaults: development console, everything else noop', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(resolveFcmProviderKind(raw, 'development')).toBe('console');
      expect(resolveFcmProviderKind(raw, 'test')).toBe('noop');
      expect(resolveFcmProviderKind(raw, 'production')).toBe('noop');
    }
  });
});

describe('validateEnv: Agora RTC', () => {
  it('allows both Agora variables to be unset', () => {
    expect(() => validateEnv({ ...baseEnv })).not.toThrow();
  });

  it('accepts both App ID and certificate together', () => {
    const env = validateEnv({
      ...baseEnv,
      AGORA_APP_ID: '  test-app-id  ',
      AGORA_APP_CERTIFICATE: '  test-app-cert  ',
    });
    expect(env.AGORA_APP_ID).toBe('test-app-id');
    expect(env.AGORA_APP_CERTIFICATE).toBe('test-app-cert');
  });

  it('rejects when only one of the Agora variables is set', () => {
    expect(() => validateEnv({ ...baseEnv, AGORA_APP_ID: 'only-id' })).toThrow(
      /both be set or both unset/,
    );
    expect(() =>
      validateEnv({ ...baseEnv, AGORA_APP_CERTIFICATE: 'only-cert' }),
    ).toThrow(/both be set or both unset/);
  });

  it('treats blank Agora values as unset', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        AGORA_APP_ID: '   ',
        AGORA_APP_CERTIFICATE: '',
      }),
    ).not.toThrow();
  });
});

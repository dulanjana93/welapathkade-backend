import { selectSmsSender } from '../auth/auth.module';
import { ConsoleSmsSender } from '../auth/providers/console-sms.sender';
import { MockPaymentGateway } from '../payments/mock-payment.gateway';
import { selectPaymentGateway } from '../payments/payments.module';
import {
  assertDevOnlyProviderAllowed,
  assertFcmProviderAllowed,
  isMockPaymentCallbackAllowed,
  isNonProductionEnv,
  isSwaggerEnabled,
  resolveCorsOrigins,
} from './runtime-safety';

const UNSAFE_ENVS: Array<string | undefined> = [
  'production',
  'Production',
  'staging',
  'prod',
  '',
  ' development',
  undefined,
];

describe('isNonProductionEnv (allowlist, fail closed)', () => {
  it.each(['development', 'test'])('allows %s', (env) => {
    expect(isNonProductionEnv(env)).toBe(true);
  });

  it.each(UNSAFE_ENVS)('treats %j as production-like', (env) => {
    expect(isNonProductionEnv(env)).toBe(false);
  });
});

describe('dev-only providers cannot boot outside development/test', () => {
  it.each(UNSAFE_ENVS)(
    'MockPaymentGateway is refused when NODE_ENV=%j',
    (env) => {
      expect(() => selectPaymentGateway(env, new MockPaymentGateway())).toThrow(
        /MockPaymentGateway is a development-only payment gateway/,
      );
    },
  );

  it.each(UNSAFE_ENVS)(
    'ConsoleSmsSender is refused when NODE_ENV=%j',
    (env) => {
      expect(() => selectSmsSender(env, new ConsoleSmsSender())).toThrow(
        /ConsoleSmsSender is a development-only SMS sender/,
      );
    },
  );

  it.each(['development', 'test'])(
    'both are allowed when NODE_ENV=%s',
    (env) => {
      const mock = new MockPaymentGateway();
      const sms = new ConsoleSmsSender();
      expect(selectPaymentGateway(env, mock)).toBe(mock);
      expect(selectSmsSender(env, sms)).toBe(sms);
    },
  );

  it('the error names the problem without leaking configuration values', () => {
    expect(() =>
      assertDevOnlyProviderAllowed(
        'payment gateway',
        'MockPaymentGateway',
        undefined,
      ),
    ).toThrow(/NODE_ENV is unset/);
  });
});

describe('push providers', () => {
  it.each(UNSAFE_ENVS)('console is refused when NODE_ENV=%j', (env) => {
    expect(() => assertFcmProviderAllowed('console', env)).toThrow(
      /ConsoleFcmProvider is a development-only/,
    );
  });

  it('console is allowed in development and test', () => {
    expect(assertFcmProviderAllowed('console', 'development')).toEqual({
      warnNoDelivery: false,
    });
    expect(assertFcmProviderAllowed('console', 'test')).toEqual({
      warnNoDelivery: false,
    });
  });

  it('noop is allowed everywhere but flagged outside development/test', () => {
    expect(assertFcmProviderAllowed('noop', 'production')).toEqual({
      warnNoDelivery: true,
    });
    expect(assertFcmProviderAllowed('noop', undefined)).toEqual({
      warnNoDelivery: true,
    });
    expect(assertFcmProviderAllowed('noop', 'test')).toEqual({
      warnNoDelivery: false,
    });
  });
});

describe('mock payment callbacks and Swagger share the same allowlist', () => {
  it.each(UNSAFE_ENVS)('disabled when NODE_ENV=%j', (env) => {
    expect(isMockPaymentCallbackAllowed(env)).toBe(false);
    expect(isSwaggerEnabled(env)).toBe(false);
  });

  it.each(['development', 'test'])('enabled when NODE_ENV=%s', (env) => {
    expect(isMockPaymentCallbackAllowed(env)).toBe(true);
    expect(isSwaggerEnabled(env)).toBe(true);
  });
});

describe('resolveCorsOrigins', () => {
  it('falls back to localhost defaults only in development/test', () => {
    expect(resolveCorsOrigins(undefined, 'development')).toContain(
      'http://localhost:3000',
    );
    expect(resolveCorsOrigins('', 'test').length).toBeGreaterThan(0);
  });

  it('honours an explicit list in development', () => {
    expect(
      resolveCorsOrigins(
        ' https://a.example , https://b.example',
        'development',
      ),
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it.each(['production', 'staging', undefined])(
    'requires CORS_ORIGINS to be set when NODE_ENV=%j',
    (env) => {
      expect(() => resolveCorsOrigins(undefined, env)).toThrow(
        /CORS_ORIGINS must be set explicitly/,
      );
      expect(() => resolveCorsOrigins('  , ', env)).toThrow(
        /CORS_ORIGINS must be set explicitly/,
      );
    },
  );

  it('rejects wildcards (credentials are enabled) outside development/test', () => {
    expect(() => resolveCorsOrigins('*', 'production')).toThrow(/wildcards/);
    expect(() =>
      resolveCorsOrigins('https://*.example.com', 'production'),
    ).toThrow(/wildcards/);
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3001',
    'https://localhost',
  ])('rejects the local origin %s outside development/test', (origin) => {
    expect(() =>
      resolveCorsOrigins(`https://admin.example.com,${origin}`, 'production'),
    ).toThrow(/local origin/);
  });

  it('accepts explicit production origins', () => {
    expect(
      resolveCorsOrigins('https://admin.welapathkade.lk', 'production'),
    ).toEqual(['https://admin.welapathkade.lk']);
  });
});

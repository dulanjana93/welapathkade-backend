import { createNotifySmsSender, selectSmsSender } from '../auth/auth.module';
import { ConsoleSmsSender } from '../auth/providers/console-sms.sender';
import { NotifySmsSender } from '../auth/providers/notify-sms.sender';
import { MockPaymentGateway } from '../payments/mock-payment.gateway';
import { officialPayHereUrls } from '../payments/payhere/payhere.gateway';
import { selectPaymentGateway } from '../payments/payments.module';
import type { PaymentGateway } from '../payments/payment-gateway';
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
      expect(() => selectPaymentGateway(env, undefined, new MockPaymentGateway())).toThrow(
        /MockPaymentGateway is a development-only payment gateway/,
      );
    },
  );

  it.each(UNSAFE_ENVS)(
    'selects NotifySmsSender instead of ConsoleSmsSender when NODE_ENV=%j',
    (env) => {
      const consoleSender = new ConsoleSmsSender();
      const notify = new NotifySmsSender(
        { userId: 'notify-user', apiKey: 'notify-key', senderId: 'Welapathkade' },
        jest.fn(),
      );
      expect(selectSmsSender(env, consoleSender, notify)).toBe(notify);
    },
  );

  it.each(UNSAFE_ENVS)(
    'refuses to boot without Notify.lk settings when NODE_ENV=%j',
    (env) => {
      expect(() => selectSmsSender(env, new ConsoleSmsSender())).toThrow(
        /NOTIFY_LK_USER_ID, NOTIFY_LK_API_KEY, and NOTIFY_LK_SENDER_ID must be set/,
      );
    },
  );

  it('keeps NotifySmsSender selected in production', () => {
    const consoleSender = new ConsoleSmsSender();
    const notify = new NotifySmsSender(
      { userId: 'notify-user', apiKey: 'notify-key', senderId: 'NotifyDEMO' },
      jest.fn(),
    );
    expect(selectSmsSender('production', consoleSender, notify)).toBe(notify);
    expect(selectSmsSender('production', consoleSender, notify)).not.toBe(
      consoleSender,
    );
  });

  it.each(['development', 'test'])(
    'both dev providers are allowed when NODE_ENV=%s',
    (env) => {
      const mock = new MockPaymentGateway();
      const sms = new ConsoleSmsSender();
      const notify = new NotifySmsSender(
        { userId: 'notify-user', apiKey: 'notify-key', senderId: 'Welapathkade' },
        jest.fn(),
      );
      expect(selectPaymentGateway(env, undefined, mock)).toBe(mock);
      expect(selectSmsSender(env, sms, notify)).toBe(sms);
    },
  );

  it('rejects a partial Notify.lk configuration without echoing the secret', () => {
    expect(() => createNotifySmsSender({ apiKey: 'super-secret-key' })).toThrow(
      /NOTIFY_LK_USER_ID, NOTIFY_LK_API_KEY, and NOTIFY_LK_SENDER_ID must all be set together/,
    );
    try {
      createNotifySmsSender({ apiKey: 'super-secret-key' });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });

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

describe('hosted PayHere sandbox authorization', () => {
  const payhere = { provider: 'PAYHERE' } as PaymentGateway;

  it('selects the PayHere gateway and sandbox endpoints when production sandbox is authorized', () => {
    const mock = new MockPaymentGateway();
    expect(selectPaymentGateway('production', 'sandbox', mock, payhere, true)).toBe(
      payhere,
    );
    expect(officialPayHereUrls('sandbox')).toEqual({
      checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
      oauthUrl: 'https://sandbox.payhere.lk/merchant/v1/oauth/token',
      retrievalUrl: 'https://sandbox.payhere.lk/merchant/v1/payment/search',
      refundUrl: 'https://sandbox.payhere.lk/merchant/v1/payment/refund',
      preapprovalUrl: 'https://sandbox.payhere.lk/pay/preapprove',
      chargeUrl: 'https://sandbox.payhere.lk/merchant/v1/payment/charge',
    });
    expect(isSwaggerEnabled('production')).toBe(false);
    expect(isMockPaymentCallbackAllowed('production')).toBe(false);
    expect(() => resolveCorsOrigins(undefined, 'production')).toThrow(
      /CORS_ORIGINS must be set explicitly/,
    );
  });

  it('selects live endpoints for production live mode', () => {
    const mock = new MockPaymentGateway();
    expect(selectPaymentGateway('production', 'live', mock, payhere, false)).toBe(
      payhere,
    );
    expect(officialPayHereUrls('live').checkoutUrl).toBe(
      'https://www.payhere.lk/pay/checkout',
    );
    expect(officialPayHereUrls('live').oauthUrl).toBe(
      'https://www.payhere.lk/merchant/v1/oauth/token',
    );
  });

  it('rejects production sandbox without authorization and never selects the mock gateway', () => {
    const mock = new MockPaymentGateway();
    expect(() =>
      selectPaymentGateway('production', 'sandbox', mock, payhere, false),
    ).toThrow(/Production requires PAYHERE_MODE=live/);
    expect(() => selectPaymentGateway('production', 'sandbox', mock, payhere)).toThrow(
      /Production requires PAYHERE_MODE=live/,
    );
    expect(() =>
      selectPaymentGateway('production', undefined, mock, undefined, true),
    ).toThrow(/MockPaymentGateway is a development-only payment gateway/);
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

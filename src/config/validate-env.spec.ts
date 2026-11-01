import 'reflect-metadata';
import { resolveFcmProviderKind } from '../notifications/fcm-provider.interface';
import { validateEnv } from './validate-env';

const s3Env = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'private-consultations',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const notifyEnv = {
  NOTIFY_LK_USER_ID: 'notify-user',
  NOTIFY_LK_API_KEY: 'notify-key',
  NOTIFY_LK_SENDER_ID: 'Welapathkade',
};

const payhereEnv = {
  PAYHERE_MODE: 'live',
  PAYHERE_MERCHANT_ID: 'merchant-1',
  PAYHERE_MERCHANT_SECRET: 'merchant-secret',
  PAYHERE_APP_ID: 'app-id',
  PAYHERE_APP_SECRET: 'app-secret',
  PAYHERE_NOTIFY_URL: 'https://api.example.com/payments/callbacks/payhere',
  PAYHERE_RETURN_URL: 'https://app.example.com/payments/return',
  PAYHERE_CANCEL_URL: 'https://app.example.com/payments/cancel',
};

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

  it.each(['development', 'test'])('accepts %s', (env) => {
    expect(validateEnv({ ...baseEnv, NODE_ENV: env }).NODE_ENV).toBe(env);
  });

  it('accepts production when private S3 storage and Notify.lk are configured', () => {
    expect(
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        ...s3Env,
        ...notifyEnv,
        ...payhereEnv,
      }).NODE_ENV,
    ).toBe('production');
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

describe('validateEnv: object storage', () => {
  it('allows local storage outside production', () => {
    expect(validateEnv({ ...baseEnv }).STORAGE_DRIVER).toBeUndefined();
    expect(
      validateEnv({ ...baseEnv, STORAGE_DRIVER: 'local' }).STORAGE_DRIVER,
    ).toBe('local');
  });

  it('rejects local storage in production, including when the driver is unset', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production' })).toThrow(
      /STORAGE_DRIVER must be s3 in production/,
    );
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        STORAGE_DRIVER: 'local',
      }),
    ).toThrow(/STORAGE_DRIVER must be s3 in production/);
  });

  it('accepts Cloudflare R2 settings and trims them', () => {
    const env = validateEnv({
      ...baseEnv,
      STORAGE_DRIVER: ' S3 ',
      S3_ENDPOINT: '  https://example.r2.cloudflarestorage.com/  ',
      S3_REGION: ' auto ',
      S3_BUCKET: ' private-consultations ',
      S3_ACCESS_KEY_ID: ' access-key ',
      S3_SECRET_ACCESS_KEY: ' secret-key ',
    });
    expect(env.STORAGE_DRIVER).toBe('s3');
    expect(env.S3_ENDPOINT).toBe('https://example.r2.cloudflarestorage.com/');
    expect(env.S3_REGION).toBe('auto');
    expect(env.S3_BUCKET).toBe('private-consultations');
    expect(env.S3_ACCESS_KEY_ID).toBe('access-key');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('secret-key');
  });

  it('defaults an omitted region to acceptance (the client uses auto)', () => {
    expect(
      validateEnv({ ...baseEnv, ...s3Env, S3_REGION: undefined }).S3_REGION,
    ).toBeUndefined();
  });

  it.each([
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ])('requires %s when STORAGE_DRIVER=s3', (name) => {
    expect(() =>
      validateEnv({ ...baseEnv, ...s3Env, [name]: undefined }),
    ).toThrow(new RegExp(`${name} must be set when STORAGE_DRIVER=s3`));
  });

  it('rejects a region other than auto', () => {
    expect(() =>
      validateEnv({ ...baseEnv, ...s3Env, S3_REGION: 'Asia-Pacific' }),
    ).toThrow(/S3_REGION must be auto/);
  });

  it('rejects an endpoint that includes the bucket path or credentials', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com/welapathkade',
      }),
    ).toThrow(/without a bucket path/);
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        S3_ENDPOINT: 'http://example.r2.cloudflarestorage.com',
      }),
    ).toThrow(/https URL/);
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        S3_ENDPOINT: 'https://key:secret@example.r2.cloudflarestorage.com',
      }),
    ).toThrow(/without embedded credentials/);
  });
});

describe('validateEnv: Notify.lk', () => {
  const production = {
    ...baseEnv,
    ...s3Env,
    NODE_ENV: 'production',
  };

  it('allows all three Notify.lk settings to be unset outside production', () => {
    expect(validateEnv({ ...baseEnv }).NOTIFY_LK_USER_ID).toBeUndefined();
  });

  it('trims a complete set and does not echo the values in errors', () => {
    const env = validateEnv({
      ...baseEnv,
      NOTIFY_LK_USER_ID: '  notify-user  ',
      NOTIFY_LK_API_KEY: '  notify-key  ',
      NOTIFY_LK_SENDER_ID: '  Welapathkade  ',
    });
    expect(env.NOTIFY_LK_USER_ID).toBe('notify-user');
    expect(env.NOTIFY_LK_API_KEY).toBe('notify-key');
    expect(env.NOTIFY_LK_SENDER_ID).toBe('Welapathkade');
  });

  it('rejects a partial set without including the configured value', () => {
    expect(() =>
      validateEnv({ ...baseEnv, NOTIFY_LK_API_KEY: 'super-secret-key' }),
    ).toThrow(/NOTIFY_LK_USER_ID, NOTIFY_LK_SENDER_ID must be set together/);
    try {
      validateEnv({ ...baseEnv, NOTIFY_LK_API_KEY: 'super-secret-key' });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });

  it('requires all three settings in production', () => {
    expect(() => validateEnv(production)).toThrow(
      /NOTIFY_LK_USER_ID, NOTIFY_LK_API_KEY, NOTIFY_LK_SENDER_ID must be set in production/,
    );
  });

  it.each(['NOTIFY_LK_USER_ID', 'NOTIFY_LK_API_KEY', 'NOTIFY_LK_SENDER_ID'])(
    'fails production when %s is missing and does not print the other values',
    (name) => {
      let thrown: Error | undefined;
      try {
        validateEnv({ ...production, ...notifyEnv, [name]: undefined });
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.message).toContain(`${name} must be set in production`);
      expect(thrown?.message).not.toContain('notify-user');
      expect(thrown?.message).not.toContain('notify-key');
      expect(thrown?.message).not.toContain('Welapathkade');
    },
  );

  it('rejects the NotifyDEMO sender for production OTP delivery', () => {
    expect(() =>
      validateEnv({
        ...production,
        ...notifyEnv,
        NOTIFY_LK_SENDER_ID: 'NotifyDEMO',
      }),
    ).toThrow(/approved by Notify.lk/);
  });

  it('accepts an approved production sender without the demo override', () => {
    const env = validateEnv({
      ...production,
      ...notifyEnv,
      ...payhereEnv,
    });
    expect(env.NOTIFY_LK_SENDER_ID).toBe('Welapathkade');
    expect(env.NOTIFY_LK_ALLOW_DEMO_SENDER).toBeUndefined();
  });

  it('accepts NotifyDEMO only for authorized production sandbox', () => {
    const env = validateEnv({
      ...production,
      ...notifyEnv,
      PAYHERE_MODE: 'sandbox',
      PAYHERE_ALLOW_SANDBOX: 'true',
      PAYHERE_MERCHANT_ID: 'merchant-1',
      PAYHERE_MERCHANT_SECRET: 'merchant-secret',
      PAYHERE_APP_ID: 'app-id',
      PAYHERE_APP_SECRET: 'app-secret',
      PAYHERE_NOTIFY_URL: 'https://api.example.com/payments/callbacks/payhere',
      PAYHERE_RETURN_URL: 'https://app.example.com/payments/return',
      PAYHERE_CANCEL_URL: 'https://app.example.com/payments/cancel',
      NOTIFY_LK_SENDER_ID: 'NotifyDEMO',
      NOTIFY_LK_ALLOW_DEMO_SENDER: ' TRUE ',
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.PAYHERE_MODE).toBe('sandbox');
    expect(env.NOTIFY_LK_SENDER_ID).toBe('NotifyDEMO');
    expect(env.NOTIFY_LK_ALLOW_DEMO_SENDER).toBe('true');
  });

  it('rejects NotifyDEMO when the override is combined with live PayHere', () => {
    expect(() =>
      validateEnv({
        ...production,
        ...notifyEnv,
        ...payhereEnv,
        NOTIFY_LK_SENDER_ID: 'NotifyDEMO',
        NOTIFY_LK_ALLOW_DEMO_SENDER: 'true',
      }),
    ).toThrow(/NOTIFY_LK_ALLOW_DEMO_SENDER=true requires/);
  });

  it('rejects NotifyDEMO when sandbox authorization is missing', () => {
    expect(() =>
      validateEnv({
        ...production,
        ...notifyEnv,
        PAYHERE_MODE: 'sandbox',
        NOTIFY_LK_SENDER_ID: 'NotifyDEMO',
        NOTIFY_LK_ALLOW_DEMO_SENDER: 'true',
      }),
    ).toThrow(/PAYHERE_ALLOW_SANDBOX=true/);
  });

  it('keeps development Notify.lk behavior unchanged', () => {
    const env = validateEnv({
      ...baseEnv,
      ...notifyEnv,
      NOTIFY_LK_SENDER_ID: 'NotifyDEMO',
    });
    expect(env.NOTIFY_LK_SENDER_ID).toBe('NotifyDEMO');
    expect(env.NOTIFY_LK_ALLOW_DEMO_SENDER).toBeUndefined();
  });
});

describe('validateEnv: PayHere', () => {
  const sandbox = {
    PAYHERE_MODE: 'sandbox',
    PAYHERE_MERCHANT_ID: 'merchant-1',
    PAYHERE_MERCHANT_SECRET: 'merchant-secret',
    PAYHERE_APP_ID: 'app-id',
    PAYHERE_APP_SECRET: 'app-secret',
    PAYHERE_NOTIFY_URL: 'https://api.example.com/payments/callbacks/payhere',
    PAYHERE_RETURN_URL: 'https://app.example.com/payments/return',
    PAYHERE_CANCEL_URL: 'https://app.example.com/payments/cancel',
  };

  it('allows development to keep the mock gateway when PayHere is unset', () => {
    expect(validateEnv({ ...baseEnv }).PAYHERE_MODE).toBeUndefined();
  });

  it('accepts a complete sandbox configuration', () => {
    expect(validateEnv({ ...baseEnv, ...sandbox }).PAYHERE_MODE).toBe('sandbox');
  });

  it('rejects sandbox credentials in production without explicit authorization', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        ...notifyEnv,
        ...sandbox,
        NODE_ENV: 'production',
      }),
    ).toThrow(/PAYHERE_ALLOW_SANDBOX=true/);
  });

  it('accepts production sandbox only when PAYHERE_ALLOW_SANDBOX=true', () => {
    const validated = validateEnv({
      ...baseEnv,
      ...s3Env,
      ...notifyEnv,
      ...sandbox,
      NODE_ENV: 'production',
      PAYHERE_ALLOW_SANDBOX: ' TRUE ',
      PAYHERE_CHECKOUT_URL: 'https://sandbox.payhere.lk/pay/checkout',
      PAYHERE_OAUTH_URL: 'https://sandbox.payhere.lk/merchant/v1/oauth/token',
    });
    expect(validated.NODE_ENV).toBe('production');
    expect(validated.PAYHERE_MODE).toBe('sandbox');
    expect(validated.PAYHERE_ALLOW_SANDBOX).toBe('true');
  });

  it('rejects a live checkout or OAuth URL for authorized production sandbox', () => {
    const hosted = {
      ...baseEnv,
      ...s3Env,
      ...notifyEnv,
      ...sandbox,
      NODE_ENV: 'production',
      PAYHERE_ALLOW_SANDBOX: 'true',
    };
    expect(() =>
      validateEnv({
        ...hosted,
        PAYHERE_CHECKOUT_URL: 'https://www.payhere.lk/pay/checkout',
      }),
    ).toThrow(
      /PAYHERE_CHECKOUT_URL must be https:\/\/sandbox\.payhere\.lk\/pay\/checkout/,
    );
    expect(() =>
      validateEnv({
        ...hosted,
        PAYHERE_OAUTH_URL: 'https://www.payhere.lk/merchant/v1/oauth/token',
      }),
    ).toThrow(
      /PAYHERE_OAUTH_URL must be https:\/\/sandbox\.payhere\.lk\/merchant\/v1\/oauth\/token/,
    );
  });

  it('rejects a sandbox checkout or OAuth URL for production live mode', () => {
    const hosted = {
      ...baseEnv,
      ...s3Env,
      ...notifyEnv,
      ...payhereEnv,
      NODE_ENV: 'production',
    };
    expect(() =>
      validateEnv({
        ...hosted,
        PAYHERE_CHECKOUT_URL: 'https://sandbox.payhere.lk/pay/checkout',
      }),
    ).toThrow(
      /PAYHERE_CHECKOUT_URL must be https:\/\/www\.payhere\.lk\/pay\/checkout/,
    );
    expect(() =>
      validateEnv({
        ...hosted,
        PAYHERE_OAUTH_URL: 'https://sandbox.payhere.lk/merchant/v1/oauth/token',
      }),
    ).toThrow(
      /PAYHERE_OAUTH_URL must be https:\/\/www\.payhere\.lk\/merchant\/v1\/oauth\/token/,
    );
  });

  it('rejects an invalid PayHere mode and a sandbox flag without sandbox mode', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        ...notifyEnv,
        ...payhereEnv,
        NODE_ENV: 'production',
        PAYHERE_MODE: 'test',
      }),
    ).toThrow(/Environment validation failed/);
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        ...notifyEnv,
        ...payhereEnv,
        NODE_ENV: 'production',
        PAYHERE_ALLOW_SANDBOX: 'true',
      }),
    ).toThrow(/PAYHERE_ALLOW_SANDBOX=true requires PAYHERE_MODE=sandbox/);
  });

  it('rejects a live checkout URL while the mode is sandbox', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...sandbox,
        PAYHERE_CHECKOUT_URL: 'https://www.payhere.lk/pay/checkout',
      }),
    ).toThrow(/PAYHERE_CHECKOUT_URL must be https:\/\/sandbox\.payhere\.lk\/pay\/checkout/);
  });

  it('does not echo the merchant secret', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        PAYHERE_MODE: 'sandbox',
        PAYHERE_MERCHANT_SECRET: 'super-secret-key',
      }),
    ).toThrow(/PAYHERE_MERCHANT_ID/);
    try {
      validateEnv({
        ...baseEnv,
        PAYHERE_MODE: 'sandbox',
        PAYHERE_MERCHANT_SECRET: 'super-secret-key',
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });
});

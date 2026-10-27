import 'reflect-metadata';
import { validateEnv } from '../config/validate-env';
import { resolveExpirySweepConfig } from './expiry-sweep.config';

describe('resolveExpirySweepConfig', () => {
  it('is disabled by default in the test environment', () => {
    expect(resolveExpirySweepConfig({ nodeEnv: 'test' }).enabled).toBe(false);
  });

  it.each(['development', 'production', undefined])(
    'is enabled by default when NODE_ENV=%s',
    (nodeEnv) => {
      expect(resolveExpirySweepConfig({ nodeEnv }).enabled).toBe(true);
    },
  );

  it('an explicit setting wins in every environment', () => {
    expect(
      resolveExpirySweepConfig({ nodeEnv: 'test', enabled: 'true' }).enabled,
    ).toBe(true);
    expect(
      resolveExpirySweepConfig({ nodeEnv: 'production', enabled: ' FALSE ' })
        .enabled,
    ).toBe(false);
  });

  it('rejects an unknown enabled value', () => {
    expect(() =>
      resolveExpirySweepConfig({ nodeEnv: 'development', enabled: 'yes' }),
    ).toThrow(/EXPIRY_SWEEP_ENABLED/);
  });

  it('defaults to 60 seconds', () => {
    expect(
      resolveExpirySweepConfig({ nodeEnv: 'development' }).intervalMs,
    ).toBe(60_000);
    expect(
      resolveExpirySweepConfig({ nodeEnv: 'development', intervalSeconds: '' })
        .intervalMs,
    ).toBe(60_000);
  });

  it.each([
    ['5', 5_000],
    ['30', 30_000],
    [3600, 3_600_000],
  ])('accepts interval %s seconds', (seconds, expected) => {
    expect(
      resolveExpirySweepConfig({
        nodeEnv: 'development',
        intervalSeconds: seconds,
      }).intervalMs,
    ).toBe(expected);
  });

  it.each(['0', '4', '3601', '-1', '1.5', 'abc', 'NaN'])(
    'rejects interval %s (never a hot loop)',
    (seconds) => {
      expect(() =>
        resolveExpirySweepConfig({
          nodeEnv: 'development',
          intervalSeconds: seconds,
        }),
      ).toThrow(/EXPIRY_SWEEP_INTERVAL_SECONDS/);
    },
  );
});

describe('validateEnv: expiry sweep settings', () => {
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

  it('both settings are optional', () => {
    expect(() => validateEnv({ ...baseEnv })).not.toThrow();
    expect(() =>
      validateEnv({
        ...baseEnv,
        EXPIRY_SWEEP_ENABLED: '',
        EXPIRY_SWEEP_INTERVAL_SECONDS: '',
      }),
    ).not.toThrow();
  });

  it.each(['true', 'false', ' TRUE '])('accepts enabled=%j', (value) => {
    expect(() =>
      validateEnv({ ...baseEnv, EXPIRY_SWEEP_ENABLED: value }),
    ).not.toThrow();
  });

  it.each(['yes', '1', 'on'])('rejects enabled=%j', (value) => {
    expect(() =>
      validateEnv({ ...baseEnv, EXPIRY_SWEEP_ENABLED: value }),
    ).toThrow(/Environment validation failed/);
  });

  it.each(['5', '60', '3600'])('accepts interval=%s', (value) => {
    expect(
      validateEnv({ ...baseEnv, EXPIRY_SWEEP_INTERVAL_SECONDS: value })
        .EXPIRY_SWEEP_INTERVAL_SECONDS,
    ).toBe(Number(value));
  });

  it.each(['0', '4', '3601', 'abc', '2.5'])('rejects interval=%s', (value) => {
    expect(() =>
      validateEnv({ ...baseEnv, EXPIRY_SWEEP_INTERVAL_SECONDS: value }),
    ).toThrow(/Environment validation failed/);
  });
});

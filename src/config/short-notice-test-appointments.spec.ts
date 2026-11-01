import 'reflect-metadata';
import { MIN_BOOKING_LEAD_MINUTES } from '../availability/availability.constants';
import {
  assertShortNoticeTestAppointmentsEnv,
  isShortNoticeTestAppointmentsEnabled,
  resolveProposalMinLeadMinutes,
  SHORT_NOTICE_TEST_LEAD_MINUTES,
} from './short-notice-test-appointments';
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

describe('short-notice test appointment override', () => {
  it('defaults to the normal 60-minute lead when the flag is unset', () => {
    expect(resolveProposalMinLeadMinutes(undefined, 'development')).toBe(
      MIN_BOOKING_LEAD_MINUTES,
    );
    expect(isShortNoticeTestAppointmentsEnabled(undefined, 'development')).toBe(
      false,
    );
  });

  it.each(['development', 'test'])(
    'reduces lead to 5 minutes when enabled in %s',
    (env) => {
      expect(resolveProposalMinLeadMinutes('true', env)).toBe(
        SHORT_NOTICE_TEST_LEAD_MINUTES,
      );
      expect(isShortNoticeTestAppointmentsEnabled('true', env)).toBe(true);
    },
  );

  it('keeps 60 minutes when the flag is false in development', () => {
    expect(resolveProposalMinLeadMinutes('false', 'development')).toBe(
      MIN_BOOKING_LEAD_MINUTES,
    );
  });

  it('fail-closed: never enables the override outside development/test', () => {
    for (const env of ['production', undefined, 'staging', '']) {
      expect(isShortNoticeTestAppointmentsEnabled('true', env)).toBe(false);
      expect(resolveProposalMinLeadMinutes('true', env)).toBe(
        MIN_BOOKING_LEAD_MINUTES,
      );
    }
  });

  it('startup rejects the override in production', () => {
    expect(() =>
      assertShortNoticeTestAppointmentsEnv('true', 'production'),
    ).toThrow(/ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS/);
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS: 'true',
        CORS_ORIGINS: 'https://example.com',
      }),
    ).toThrow(/ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS/);
  });

  it('startup accepts the override in development and test', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'development',
        ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS: 'true',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS: 'true',
      }),
    ).not.toThrow();
  });

  it('startup accepts production when the override is false or unset', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        ...notifyEnv,
        ...payhereEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://example.com',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...s3Env,
        ...notifyEnv,
        ...payhereEnv,
        NODE_ENV: 'production',
        ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS: 'false',
        CORS_ORIGINS: 'https://example.com',
      }),
    ).not.toThrow();
  });
});

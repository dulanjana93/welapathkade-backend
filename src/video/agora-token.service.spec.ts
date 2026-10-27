import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgoraTokenService } from './agora-token.service';

/** 32-char hex placeholders — agora-token rejects non-hex App IDs with "". */
const TEST_APP_ID = 'a1b2c3d4e5f64789a0b1c2d3e4f50617';
const TEST_APP_CERT = 'f1e2d3c4b5a697887766554433221100';

function serviceWithConfig(env: Record<string, string | undefined>) {
  const config = {
    get: (key: string) => {
      if (key === 'app.agoraAppId') return env.AGORA_APP_ID;
      if (key === 'app.agoraAppCertificate') return env.AGORA_APP_CERTIFICATE;
      return undefined;
    },
  } as unknown as ConfigService;
  return new AgoraTokenService(config);
}

describe('AgoraTokenService', () => {
  it('fails closed when Agora env is missing', () => {
    const svc = serviceWithConfig({});
    expect(svc.isConfigured()).toBe(false);
    expect(() =>
      svc.issueRtcCredentials({
        appointmentId: 'apt-1',
        participantRole: 'CUSTOMER',
        ttlSeconds: 120,
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it('issues AccessToken2 credentials without exposing the certificate', () => {
    const svc = serviceWithConfig({
      AGORA_APP_ID: TEST_APP_ID,
      AGORA_APP_CERTIFICATE: TEST_APP_CERT,
    });
    const now = new Date('2026-10-10T12:00:00.000Z');
    const creds = svc.issueRtcCredentials({
      appointmentId: 'apt-1',
      participantRole: 'CUSTOMER',
      ttlSeconds: 300,
      now,
    });

    expect(creds.provider).toBe('agora');
    expect(creds.appId).toBe(TEST_APP_ID);
    expect(creds.channelName).toMatch(/^wp_[0-9a-f]{32}$/);
    expect(creds.uid).toBeGreaterThan(0);
    expect(creds.token.length).toBeGreaterThan(20);
    expect(creds.tokenExpiresAt).toBe('2026-10-10T12:05:00.000Z');
    expect(creds.privilegeExpiresAt).toBe(creds.tokenExpiresAt);

    const serialized = JSON.stringify(creds);
    expect(serialized).not.toContain(TEST_APP_CERT);
    expect(serialized).not.toMatch(/certificate/i);
    expect(creds).not.toHaveProperty('appCertificate');
    expect(creds).not.toHaveProperty('AGORA_APP_CERTIFICATE');
  });

  it('gives both roles the same channel and different UIDs', () => {
    const svc = serviceWithConfig({
      AGORA_APP_ID: TEST_APP_ID,
      AGORA_APP_CERTIFICATE: TEST_APP_CERT,
    });
    const customer = svc.issueRtcCredentials({
      appointmentId: 'apt-shared',
      participantRole: 'CUSTOMER',
      ttlSeconds: 120,
    });
    const astrologer = svc.issueRtcCredentials({
      appointmentId: 'apt-shared',
      participantRole: 'ASTROLOGER',
      ttlSeconds: 120,
    });
    expect(customer.channelName).toBe(astrologer.channelName);
    expect(customer.uid).not.toBe(astrologer.uid);

    const binding = svc.describeChannelBinding('apt-shared');
    expect(binding.channelName).toBe(customer.channelName);
    expect(binding.customerUid).toBe(customer.uid);
    expect(binding.astrologerUid).toBe(astrologer.uid);
  });
});

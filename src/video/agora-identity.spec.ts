import { buildAgoraChannelName, buildAgoraUid } from './agora-identity';

describe('agora-identity', () => {
  const secret = 'test-agora-app-certificate-not-real';
  const appointmentId = 'apt_cuid_example_001';

  it('builds a stable appointment-specific channel that does not embed the appointment id', () => {
    const a = buildAgoraChannelName(appointmentId, secret);
    const b = buildAgoraChannelName(appointmentId, secret);
    expect(a).toBe(b);
    expect(a).toMatch(/^wp_[0-9a-f]{32}$/);
    expect(a).not.toContain(appointmentId);
  });

  it('changes channel when the appointment id or secret changes', () => {
    const base = buildAgoraChannelName(appointmentId, secret);
    expect(buildAgoraChannelName('apt_other', secret)).not.toBe(base);
    expect(buildAgoraChannelName(appointmentId, 'other-secret')).not.toBe(base);
  });

  it('maps customer and astrologer to distinct stable UIDs without using user ids', () => {
    const customer = buildAgoraUid(appointmentId, 'CUSTOMER', secret);
    const astrologer = buildAgoraUid(appointmentId, 'ASTROLOGER', secret);
    expect(customer).toBeGreaterThan(0);
    expect(astrologer).toBeGreaterThan(0);
    expect(customer).not.toBe(astrologer);
    expect(buildAgoraUid(appointmentId, 'CUSTOMER', secret)).toBe(customer);
    expect(buildAgoraUid(appointmentId, 'ASTROLOGER', secret)).toBe(astrologer);
    expect(customer).toBeLessThanOrEqual(0xffffffff);
  });
});

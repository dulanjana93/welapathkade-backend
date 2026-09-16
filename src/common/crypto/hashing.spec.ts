import {
  generateNumericOtp,
  hashOtpCode,
  hashRefreshToken,
  safeEqualHex,
} from './hashing';

describe('hashing helpers', () => {
  it('generates numeric OTPs of the requested length', () => {
    const code = generateNumericOtp(6);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('hashes OTP codes deterministically without storing plaintext', () => {
    const hash = hashOtpCode('123456', '+94771234567', 'secret');
    expect(hash).toBe(hashOtpCode('123456', '+94771234567', 'secret'));
    expect(hash).not.toContain('123456');
    expect(safeEqualHex(hash, hashOtpCode('123456', '+94771234567', 'secret'))).toBe(
      true,
    );
  });

  it('hashes refresh tokens', () => {
    const token = 'refresh-token-value';
    expect(hashRefreshToken(token)).not.toBe(token);
    expect(hashRefreshToken(token)).toHaveLength(64);
  });
});

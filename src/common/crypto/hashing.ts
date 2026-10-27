import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function hashOtpCode(
  code: string,
  phone: string,
  secret: string,
): string {
  return hmacSha256(`${phone}:${code}`, secret);
}

export function generateNumericOtp(length: number): string {
  const max = 10 ** length;
  const num = randomBytes(4).readUInt32BE(0) % max;
  return num.toString().padStart(length, '0');
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return sha256(token);
}

export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateReferralCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

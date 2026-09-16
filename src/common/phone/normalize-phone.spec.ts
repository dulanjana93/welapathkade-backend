import { normalizePhone } from './normalize-phone';

describe('normalizePhone', () => {
  it('normalizes local Sri Lankan numbers to E.164', () => {
    expect(normalizePhone('0771234567')).toBe('+94771234567');
    expect(normalizePhone('+94771234567')).toBe('+94771234567');
    expect(normalizePhone('94771234567')).toBe('+94771234567');
    expect(normalizePhone('771234567')).toBe('+94771234567');
  });

  it('rejects invalid numbers', () => {
    expect(() => normalizePhone('123')).toThrow();
  });
});

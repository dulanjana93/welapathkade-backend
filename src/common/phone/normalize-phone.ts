import { BadRequestException } from '@nestjs/common';

/**
 * Normalizes Sri Lankan mobile numbers to E.164 (+94XXXXXXXXX).
 * Accepts +94..., 94..., 0XXXXXXXXX, and 7XXXXXXXX forms.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');

  let national: string | null = null;

  if (digits.startsWith('+94') && digits.length === 12) {
    national = digits.slice(3);
  } else if (digits.startsWith('94') && digits.length === 11) {
    national = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 10) {
    national = digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith('7')) {
    national = digits;
  }

  if (!national || !/^7\d{8}$/.test(national)) {
    throw new BadRequestException('Invalid Sri Lankan phone number');
  }

  return `+94${national}`;
}

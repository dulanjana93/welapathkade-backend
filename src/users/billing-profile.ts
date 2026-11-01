import { BadRequestException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { normalizePhone } from '../common/phone/normalize-phone';

export const BILLING_LIMITS = {
  name: 80,
  email: 254,
  address: 255,
  city: 80,
  country: 80,
} as const;

/** Fields the customer must supply. Phone comes from the account. */
export const BILLING_INPUT_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'address',
  'city',
  'country',
] as const;

export const BILLING_PROFILE_INCOMPLETE = 'BILLING_PROFILE_INCOMPLETE';

export type BillingProfileInput = {
  firstName: string;
  lastName: string;
  email: string;
  address: string;
  city: string;
  country: string;
};

export type BillingProfileView = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Account phone. There is no separate billing phone. */
  phone: string;
  address: string | null;
  city: string | null;
  country: string | null;
  complete: boolean;
  missingFields: string[];
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Two-letter values are stored as uppercase ISO codes (`lk` → `LK`).
 * Any longer country name is stored trimmed, with collapsed whitespace.
 */
export function normalizeCountry(value: string): string {
  const collapsed = collapseWhitespace(value);
  if (/^[A-Za-z]{2}$/.test(collapsed)) {
    return collapsed.toUpperCase();
  }
  return collapsed;
}

export function isBillingEmail(value: string): boolean {
  return value.length <= BILLING_LIMITS.email && EMAIL_PATTERN.test(value);
}

export function normalizeBillingInput(
  input: BillingProfileInput,
): BillingProfileInput {
  const firstName = collapseWhitespace(input.firstName ?? '');
  const lastName = collapseWhitespace(input.lastName ?? '');
  const email = collapseWhitespace(input.email ?? '').toLowerCase();
  const address = collapseWhitespace(input.address ?? '');
  const city = collapseWhitespace(input.city ?? '');
  const country = normalizeCountry(input.country ?? '');

  const invalid: string[] = [];
  if (!firstName || firstName.length > BILLING_LIMITS.name) {
    invalid.push('firstName');
  }
  if (!lastName || lastName.length > BILLING_LIMITS.name) {
    invalid.push('lastName');
  }
  if (!isBillingEmail(email)) {
    invalid.push('email');
  }
  if (!address || address.length > BILLING_LIMITS.address) {
    invalid.push('address');
  }
  if (!city || city.length > BILLING_LIMITS.city) {
    invalid.push('city');
  }
  if (!country || country.length > BILLING_LIMITS.country) {
    invalid.push('country');
  }
  if (invalid.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      message: 'Billing profile is invalid',
      error: 'Bad Request',
      code: BILLING_PROFILE_INCOMPLETE,
      missingFields: invalid,
    });
  }

  return { firstName, lastName, email, address, city, country };
}

function presentText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = collapseWhitespace(value);
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Readiness of the account billing columns plus the existing phone.
 * Does not throw. Checkout uses `missingFields` to reject a reservation.
 */
export function assessBillingProfile(user: {
  phone?: string | null;
  billingFirstName?: string | null;
  billingLastName?: string | null;
  billingEmail?: string | null;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingCountry?: string | null;
}): BillingProfileView {
  const firstName = presentText(user.billingFirstName);
  const lastName = presentText(user.billingLastName);
  const emailRaw = presentText(user.billingEmail);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const address = presentText(user.billingAddress);
  const city = presentText(user.billingCity);
  const country = presentText(user.billingCountry);
  const phone = typeof user.phone === 'string' ? user.phone : '';

  const missingFields: string[] = [];
  if (!firstName || firstName.length > BILLING_LIMITS.name) {
    missingFields.push('firstName');
  }
  if (!lastName || lastName.length > BILLING_LIMITS.name) {
    missingFields.push('lastName');
  }
  if (!email || !isBillingEmail(email)) {
    missingFields.push('email');
  }
  if (!address || address.length > BILLING_LIMITS.address) {
    missingFields.push('address');
  }
  if (!city || city.length > BILLING_LIMITS.city) {
    missingFields.push('city');
  }
  if (!country || country.length > BILLING_LIMITS.country) {
    missingFields.push('country');
  }
  if (!isAccountPhone(phone)) {
    missingFields.push('phone');
  }

  return {
    firstName,
    lastName,
    email,
    phone,
    address,
    city,
    country: country ? normalizeCountry(country) : null,
    complete: missingFields.length === 0,
    missingFields,
  };
}

export function toBillingProfileView(user: User): BillingProfileView {
  return assessBillingProfile(user);
}

function isAccountPhone(phone: string): boolean {
  if (!phone) return false;
  try {
    normalizePhone(phone);
    return true;
  } catch {
    return false;
  }
}

export function billingProfileIncompleteException(missingFields: string[]) {
  return new BadRequestException({
    statusCode: 400,
    message: 'Billing profile is incomplete',
    error: 'Bad Request',
    code: BILLING_PROFILE_INCOMPLETE,
    missingFields,
  });
}

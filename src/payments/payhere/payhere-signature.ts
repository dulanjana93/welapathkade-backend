import { createHash, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';

export const PAYHERE_SANDBOX_CHECKOUT_URL =
  'https://sandbox.payhere.lk/pay/checkout';
export const PAYHERE_LIVE_CHECKOUT_URL = 'https://www.payhere.lk/pay/checkout';
export const PAYHERE_SANDBOX_OAUTH_URL =
  'https://sandbox.payhere.lk/merchant/v1/oauth/token';
export const PAYHERE_LIVE_OAUTH_URL =
  'https://www.payhere.lk/merchant/v1/oauth/token';
export const PAYHERE_SANDBOX_RETRIEVAL_URL =
  'https://sandbox.payhere.lk/merchant/v1/payment/search';
export const PAYHERE_LIVE_RETRIEVAL_URL =
  'https://www.payhere.lk/merchant/v1/payment/search';
export const PAYHERE_SANDBOX_REFUND_URL =
  'https://sandbox.payhere.lk/merchant/v1/payment/refund';
export const PAYHERE_LIVE_REFUND_URL =
  'https://www.payhere.lk/merchant/v1/payment/refund';
export const PAYHERE_SANDBOX_PREAPPROVAL_URL =
  'https://sandbox.payhere.lk/pay/preapprove';
export const PAYHERE_LIVE_PREAPPROVAL_URL =
  'https://www.payhere.lk/pay/preapprove';
export const PAYHERE_SANDBOX_CHARGE_URL =
  'https://sandbox.payhere.lk/merchant/v1/payment/charge';
export const PAYHERE_LIVE_CHARGE_URL =
  'https://www.payhere.lk/merchant/v1/payment/charge';

/**
 * Hash amount when the pre-approval form omits `amount`.
 * PayHere documents 10.00 for LKR and 0.51 for every other currency.
 * This value is not posted and is not a consultation charge.
 */
export const PAYHERE_PREAPPROVAL_HASH_AMOUNT_LKR = '10.00';

const CARD_FIELDS = new Set([
  'card_holder_name',
  'card_no',
  'card_expiry',
  'customer_token',
]);

export type PayHereNotifyOutcome =
  | 'success'
  | 'pending'
  | 'failed'
  | 'chargedback';

export class PayHereNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayHereNotificationError';
  }
}

export function md5Upper(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex').toUpperCase();
}

/** Two decimal places, no thousands separator. This is the checkout hash amount. */
export function formatPayHereAmount(amount: string): string {
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(amount);
  } catch {
    throw new PayHereNotificationError('Payment amount is invalid');
  }
  if (!decimal.isFinite() || decimal.lte(0)) {
    throw new PayHereNotificationError('Payment amount is invalid');
  }
  return decimal.toFixed(2);
}

export function checkoutHash(input: {
  merchantId: string;
  orderId: string;
  amount: string;
  currency: string;
  merchantSecret: string;
}): string {
  const amount = formatPayHereAmount(input.amount);
  const secretHash = md5Upper(input.merchantSecret);
  return md5Upper(
    input.merchantId + input.orderId + amount + input.currency + secretHash,
  );
}

/** Uses the notification amount string exactly, as PayHere signed it. */
export function notifySignature(input: {
  merchantId: string;
  orderId: string;
  payhereAmount: string;
  payhereCurrency: string;
  statusCode: string;
  merchantSecret: string;
}): string {
  const secretHash = md5Upper(input.merchantSecret);
  return md5Upper(
    input.merchantId +
      input.orderId +
      input.payhereAmount +
      input.payhereCurrency +
      input.statusCode +
      secretHash,
  );
}

export function signaturesMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected.toUpperCase());
  const right = Buffer.from(received.toUpperCase());
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type ParsedPayHereNotification = {
  merchantReference: string;
  providerPaymentId: string;
  amount: string;
  currency: string;
  statusCode: number;
  outcome: PayHereNotifyOutcome;
  success: boolean;
  sanitized: Record<string, string>;
};

const STATUS_OUTCOME: Record<string, PayHereNotifyOutcome> = {
  '2': 'success',
  '0': 'pending',
  '-1': 'failed',
  '-2': 'failed',
  '-3': 'chargedback',
};

export function parsePayHereNotification(
  fields: Record<string, string>,
  settings: { merchantId: string; merchantSecret: string },
): ParsedPayHereNotification {
  const merchantId = requiredField(fields, 'merchant_id');
  const orderId = requiredField(fields, 'order_id');
  const payhereAmount = requiredField(fields, 'payhere_amount');
  const payhereCurrency = requiredField(fields, 'payhere_currency');
  const statusCodeRaw = requiredField(fields, 'status_code');
  const md5sig = requiredField(fields, 'md5sig');

  if (merchantId !== settings.merchantId) {
    throw new PayHereNotificationError('Incorrect merchant ID');
  }
  const outcome = STATUS_OUTCOME[statusCodeRaw];
  if (!outcome) {
    throw new PayHereNotificationError('Unknown payment status');
  }
  if (!/^[A-Z]{3}$/.test(payhereCurrency)) {
    throw new PayHereNotificationError('Incorrect currency');
  }

  const expected = notifySignature({
    merchantId,
    orderId,
    payhereAmount,
    payhereCurrency,
    statusCode: statusCodeRaw,
    merchantSecret: settings.merchantSecret,
  });
  if (!signaturesMatch(expected, md5sig)) {
    throw new PayHereNotificationError('Invalid signature');
  }

  return {
    merchantReference: orderId,
    providerPaymentId: fields.payment_id?.trim() ?? '',
    amount: payhereAmount,
    currency: payhereCurrency,
    statusCode: Number(statusCodeRaw),
    outcome,
    success: outcome === 'success',
    sanitized: sanitizePayHereFields(fields),
  };
}

export function sanitizePayHereFields(
  fields: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (CARD_FIELDS.has(key) || key === 'md5sig') continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function requiredField(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PayHereNotificationError('Malformed PayHere notification');
  }
  return value.trim();
}

export type ParsedPreapprovalNotification = {
  merchantReference: string;
  providerPaymentId: string;
  amount: string;
  currency: string;
  statusCode: number;
  outcome: 'success' | 'pending' | 'failed';
  success: boolean;
  customerToken: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
};

const PREAPPROVAL_STATUS: Record<string, 'success' | 'pending' | 'failed'> = {
  '2': 'success',
  '0': 'pending',
  '-1': 'failed',
  '-2': 'failed',
};

/** Same md5sig rules as checkout. The customer token is not part of the signature. */
export function parsePreapprovalNotification(
  fields: Record<string, string>,
  settings: { merchantId: string; merchantSecret: string },
): ParsedPreapprovalNotification {
  const merchantId = requiredField(fields, 'merchant_id');
  const orderId = requiredField(fields, 'order_id');
  const payhereAmount = requiredField(fields, 'payhere_amount');
  const payhereCurrency = requiredField(fields, 'payhere_currency');
  const statusCodeRaw = requiredField(fields, 'status_code');
  const md5sig = requiredField(fields, 'md5sig');
  if (merchantId !== settings.merchantId) {
    throw new PayHereNotificationError('Incorrect merchant ID');
  }
  const outcome = PREAPPROVAL_STATUS[statusCodeRaw];
  if (!outcome) {
    throw new PayHereNotificationError('Unknown payment status');
  }
  const expected = notifySignature({
    merchantId,
    orderId,
    payhereAmount,
    payhereCurrency,
    statusCode: statusCodeRaw,
    merchantSecret: settings.merchantSecret,
  });
  if (!signaturesMatch(expected, md5sig)) {
    throw new PayHereNotificationError('Invalid signature');
  }
  const token = fields.customer_token?.trim() ?? '';
  return {
    merchantReference: orderId,
    providerPaymentId: fields.payment_id?.trim() ?? '',
    amount: payhereAmount,
    currency: payhereCurrency,
    statusCode: Number(statusCodeRaw),
    outcome,
    success: outcome === 'success',
    customerToken: outcome === 'success' && token ? token : null,
    cardBrand: cardBrand(fields.method),
    cardLast4: maskedLast4(fields.card_no),
  };
}

function cardBrand(value: string | undefined): string | null {
  if (!value) return null;
  const brand = value.trim().toUpperCase();
  if (!/^[A-Z]{3,16}$/.test(brand)) return null;
  return brand;
}

function maskedLast4(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^\*+(\d{4})$/);
  return match?.[1] ?? null;
}

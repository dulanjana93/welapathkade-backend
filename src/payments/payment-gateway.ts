export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export type PaymentProviderName = 'MOCK' | 'PAYHERE';

export type PaymentNotifyOutcome =
  | 'success'
  | 'pending'
  | 'failed'
  | 'chargedback';

export type CreateCheckoutInput = {
  merchantReference: string;
  amount: string;
  currency: string;
  appointmentId: string;
  consultationId: string;
  customer: {
    id: string;
    name: string;
    phone: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    address?: string;
    city?: string;
    country?: string;
  };
};

export type CheckoutResult = {
  checkout: Record<string, unknown>;
};

export type NotifyResult = {
  merchantReference: string;
  providerPaymentId: string;
  amount: string;
  currency: string;
  success: boolean;
  outcome?: PaymentNotifyOutcome;
  statusCode?: number;
  sanitized?: Record<string, string>;
};

export type VerifyByReferenceResult = {
  success: boolean;
  pending?: boolean;
  ambiguous?: boolean;
  providerPaymentId?: string;
  amount?: string;
  currency?: string;
};

export interface PaymentGateway {
  readonly provider: PaymentProviderName;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  verifyNotify(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<NotifyResult>;
  verifyByReference(
    merchantReference: string,
    expected?: {
      amount: string;
      currency: string;
      providerPaymentId?: string;
    },
  ): Promise<VerifyByReferenceResult>;
}

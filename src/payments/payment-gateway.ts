export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export type PaymentProviderName = 'MOCK';

export type CreateCheckoutInput = {
  merchantReference: string;
  amount: string;
  currency: string;
  appointmentId: string;
  consultationId: string;
  customer: { id: string; name: string; phone: string };
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
};

export type VerifyByReferenceResult = {
  success: boolean;
  pending?: boolean;
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
  ): Promise<VerifyByReferenceResult>;
}

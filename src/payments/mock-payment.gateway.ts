import { Injectable } from '@nestjs/common';
import { toMoneyString } from '../common/money/money';
import type {
  CreateCheckoutInput,
  CheckoutResult,
  NotifyResult,
  PaymentGateway,
  VerifyByReferenceResult,
} from './payment-gateway';

type MockPaidRecord = {
  providerPaymentId: string;
  amount: string;
  currency: string;
};

/**
 * In-process mock gateway. Never used as proof of payment by Flutter —
 * finalize still goes through PaymentsService after verifyNotify/verifyByReference.
 */
@Injectable()
export class MockPaymentGateway implements PaymentGateway {
  readonly provider = 'MOCK' as const;

  private readonly paid = new Map<string, MockPaidRecord>();

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    return {
      checkout: {
        mock: true,
        provider: 'MOCK',
        merchantReference: input.merchantReference,
        amount: input.amount,
        currency: input.currency,
        notifyPath: '/payments/callbacks/mock',
      },
    };
  }

  async verifyNotify(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<NotifyResult> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new Error('Mock notify body must be JSON');
    }

    const merchantReference = String(parsed.merchantReference ?? '');
    if (!merchantReference) {
      throw new Error('merchantReference is required');
    }

    const success = parsed.success === true || parsed.success === 'true';
    const amount =
      parsed.amount != null ? toMoneyString(String(parsed.amount)) : '';
    // No default: a missing currency stays missing so finalization can refuse
    // it (the mock endpoint fills it from the server-stored checkout).
    const currency = String(parsed.currency ?? '');
    const providerPaymentId = String(
      parsed.providerPaymentId ?? `mock_${merchantReference}`,
    );

    if (success) {
      this.paid.set(merchantReference, {
        providerPaymentId,
        amount,
        currency,
      });
    }

    return {
      merchantReference,
      providerPaymentId,
      amount,
      currency,
      success,
    };
  }

  async verifyByReference(
    merchantReference: string,
  ): Promise<VerifyByReferenceResult> {
    const record = this.paid.get(merchantReference);
    if (!record) {
      return { success: false, pending: true };
    }
    return {
      providerPaymentId: record.providerPaymentId,
      amount: record.amount,
      currency: record.currency,
      success: true,
      pending: false,
    };
  }

  /** Test helper — not used by HTTP APIs. */
  markPaid(params: {
    merchantReference: string;
    amount: string;
    currency?: string;
  }) {
    this.paid.set(params.merchantReference, {
      providerPaymentId: `mock_${params.merchantReference}`,
      amount: params.amount,
      currency: params.currency ?? 'LKR',
    });
  }
}

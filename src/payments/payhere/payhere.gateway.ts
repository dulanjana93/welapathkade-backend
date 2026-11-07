import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { VerifyByReferenceResult } from '../payment-gateway';
import {
  payHereDestination,
  payHereErrorCategory,
  payHereErrorName,
  readPayHereResponseBody,
  summarizePayHereErrorResponse,
  type PayHereLogSink,
  type PayHereRetrievalReason,
  type PayHereUpstreamError,
} from './payhere-diagnostics';
import {
  PAYHERE_LIVE_CHARGE_URL,
  PAYHERE_LIVE_CHECKOUT_URL,
  PAYHERE_LIVE_OAUTH_URL,
  PAYHERE_LIVE_PREAPPROVAL_URL,
  PAYHERE_LIVE_REFUND_URL,
  PAYHERE_LIVE_RETRIEVAL_URL,
  PAYHERE_SANDBOX_CHARGE_URL,
  PAYHERE_SANDBOX_CHECKOUT_URL,
  PAYHERE_SANDBOX_OAUTH_URL,
  PAYHERE_SANDBOX_PREAPPROVAL_URL,
  PAYHERE_SANDBOX_REFUND_URL,
  PAYHERE_SANDBOX_RETRIEVAL_URL,
  checkoutHash,
  formatPayHereAmount,
  notifySignature,
  parsePayHereNotification,
  parsePreapprovalNotification,
  signaturesMatch,
  PAYHERE_PREAPPROVAL_HASH_AMOUNT_LKR,
  type ParsedPayHereNotification,
} from './payhere-signature';

export type PayHereMode = 'sandbox' | 'live';

export type PayHereSettings = {
  mode: PayHereMode;
  merchantId: string;
  merchantSecret: string;
  checkoutUrl: string;
  oauthUrl: string;
  retrievalUrl: string;
  refundUrl: string;
  preapprovalUrl: string;
  chargeUrl: string;
  appId: string;
  appSecret: string;
  notifyUrl: string;
  returnUrl: string;
  cancelUrl: string;
};

type TokenCache = { token: string; expiresAtMs: number };

type RetrievalRow = {
  payment_id?: number | string;
  order_id?: string;
  status?: string;
  currency?: string;
  amount?: number | string;
};

export function officialPayHereUrls(mode: PayHereMode): {
  checkoutUrl: string;
  oauthUrl: string;
  retrievalUrl: string;
  refundUrl: string;
  preapprovalUrl: string;
  chargeUrl: string;
} {
  if (mode === 'live') {
    return {
      checkoutUrl: PAYHERE_LIVE_CHECKOUT_URL,
      oauthUrl: PAYHERE_LIVE_OAUTH_URL,
      retrievalUrl: PAYHERE_LIVE_RETRIEVAL_URL,
      refundUrl: PAYHERE_LIVE_REFUND_URL,
      preapprovalUrl: PAYHERE_LIVE_PREAPPROVAL_URL,
      chargeUrl: PAYHERE_LIVE_CHARGE_URL,
    };
  }
  return {
    checkoutUrl: PAYHERE_SANDBOX_CHECKOUT_URL,
    oauthUrl: PAYHERE_SANDBOX_OAUTH_URL,
    retrievalUrl: PAYHERE_SANDBOX_RETRIEVAL_URL,
    refundUrl: PAYHERE_SANDBOX_REFUND_URL,
    preapprovalUrl: PAYHERE_SANDBOX_PREAPPROVAL_URL,
    chargeUrl: PAYHERE_SANDBOX_CHARGE_URL,
  };
}

export function assertPayHereSettings(settings: PayHereSettings): void {
  const official = officialPayHereUrls(settings.mode);
  if (settings.checkoutUrl !== official.checkoutUrl) {
    throw new Error(
      `Unsafe configuration: PAYHERE_CHECKOUT_URL must be ${official.checkoutUrl} when PAYHERE_MODE is ${settings.mode}`,
    );
  }
  if (settings.oauthUrl !== official.oauthUrl) {
    throw new Error(
      `Unsafe configuration: PAYHERE_OAUTH_URL must be ${official.oauthUrl} when PAYHERE_MODE is ${settings.mode}`,
    );
  }
  if (settings.retrievalUrl !== official.retrievalUrl) {
    throw new Error(
      'Unsafe configuration: PayHere retrieval URL does not match PAYHERE_MODE',
    );
  }
  if (settings.refundUrl !== official.refundUrl) {
    throw new Error(
      'Unsafe configuration: PayHere refund URL does not match PAYHERE_MODE',
    );
  }
  if (settings.preapprovalUrl !== official.preapprovalUrl) {
    throw new Error(
      'Unsafe configuration: PayHere pre-approval URL does not match PAYHERE_MODE',
    );
  }
  if (settings.chargeUrl !== official.chargeUrl) {
    throw new Error(
      'Unsafe configuration: PayHere charging URL does not match PAYHERE_MODE',
    );
  }
  for (const [name, value] of [
    ['PAYHERE_MERCHANT_ID', settings.merchantId],
    ['PAYHERE_MERCHANT_SECRET', settings.merchantSecret],
    ['PAYHERE_APP_ID', settings.appId],
    ['PAYHERE_APP_SECRET', settings.appSecret],
    ['PAYHERE_NOTIFY_URL', settings.notifyUrl],
    ['PAYHERE_RETURN_URL', settings.returnUrl],
    ['PAYHERE_CANCEL_URL', settings.cancelUrl],
  ] as const) {
    if (!value) {
      throw new Error(`Unsafe configuration: ${name} must be set`);
    }
  }
}

/** PayHere documents 20 requests per 10 seconds on `/merchant/v1/`. */
const MERCHANT_RATE_WINDOW_MS = 10_000;
const MERCHANT_RATE_LIMIT = 20;

export class PayHereRateLimitError extends Error {
  constructor() {
    super('PayHere merchant rate limit reached');
    this.name = 'PayHereRateLimitError';
  }
}

/** Thrown only when the charging HTTP request was not sent. */
export class PayHereChargeNotSentError extends Error {
  constructor() {
    super('PayHere charge was not sent');
    this.name = 'PayHereChargeNotSentError';
  }
}

export type PayHereChargeCall =
  | {
      /**
       * The synchronous response reported status 2. This is not proof of payment.
       * Retrieval must still match one payment before anything is finalized.
       */
      kind: 'reported';
      statusCode: 2;
      providerPaymentId: string;
      amount: string;
      currency: string;
    }
  | { kind: 'declined'; statusCode: -1 | -2 }
  | { kind: 'not-charged' }
  | { kind: 'uncertain'; providerPaymentId?: string };

/** Thrown only when the refund HTTP request was not sent. */
export class PayHereRefundNotSentError extends Error {
  constructor() {
    super('PayHere refund was not sent');
    this.name = 'PayHereRefundNotSentError';
  }
}

export type PayHereRefundCall =
  | {
      kind: 'started';
      refundNumber: string;
      providerStatus: number;
      message: string;
    }
  | { kind: 'uncertain'; providerStatus: number; message: string }
  | { kind: 'failed'; providerStatus: number; message: string };

export type RetrievedRefundState =
  | { kind: 'matched'; providerStatus: string }
  | { kind: 'not-this-payment' }
  | { kind: 'ambiguous' }
  | { kind: 'unavailable' };

export class PayHereGateway {
  readonly provider = 'PAYHERE' as const;
  private tokenCache: TokenCache | null = null;
  private readonly merchantCallsAt: number[] = [];
  private readonly logger: PayHereLogSink;

  constructor(
    private readonly settings: PayHereSettings,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    logger?: PayHereLogSink,
  ) {
    assertPayHereSettings(settings);
    this.logger = logger ?? new Logger(PayHereGateway.name);
  }

  async createCheckout(input: {
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
  }): Promise<{ checkout: Record<string, unknown> }> {
    if (input.currency !== 'LKR') {
      throw new Error('PayHere checkout currency must be LKR');
    }
    const customer = input.customer;
    const required = [
      customer.firstName,
      customer.lastName,
      customer.email,
      customer.phone,
      customer.address,
      customer.city,
      customer.country,
    ];
    if (required.some((value) => !value)) {
      throw new Error('PayHere checkout requires a complete billing profile');
    }
    const amount = formatPayHereAmount(input.amount);
    const fields: Record<string, string> = {
      merchant_id: this.settings.merchantId,
      return_url: this.settings.returnUrl,
      cancel_url: this.settings.cancelUrl,
      notify_url: this.settings.notifyUrl,
      first_name: customer.firstName!,
      last_name: customer.lastName!,
      email: customer.email!,
      phone: customer.phone,
      address: customer.address!,
      city: customer.city!,
      country: customer.country!,
      order_id: input.merchantReference,
      items: 'Welapathkade consultation',
      currency: 'LKR',
      amount,
      hash: checkoutHash({
        merchantId: this.settings.merchantId,
        orderId: input.merchantReference,
        amount,
        currency: 'LKR',
        merchantSecret: this.settings.merchantSecret,
      }),
    };
    return {
      checkout: {
        provider: 'PAYHERE',
        method: 'POST',
        action: this.settings.checkoutUrl,
        fields,
      },
    };
  }

  /**
   * Card tokenization form. `amount` is omitted so PayHere does not capture a
   * consultation payment. The hash still uses the documented LKR value 10.00.
   */
  createPreapproval(input: {
    merchantReference: string;
    customer: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      address: string;
      city: string;
      country: string;
    };
  }): { method: 'POST'; action: string; fields: Record<string, string> } {
    const fields: Record<string, string> = {
      merchant_id: this.settings.merchantId,
      return_url: this.settings.returnUrl,
      cancel_url: this.settings.cancelUrl,
      notify_url: this.settings.notifyUrl,
      first_name: input.customer.firstName,
      last_name: input.customer.lastName,
      email: input.customer.email,
      phone: input.customer.phone,
      address: input.customer.address,
      city: input.customer.city,
      country: input.customer.country,
      order_id: input.merchantReference,
      items: 'Welapathkade saved card',
      currency: 'LKR',
      hash: checkoutHash({
        merchantId: this.settings.merchantId,
        orderId: input.merchantReference,
        amount: PAYHERE_PREAPPROVAL_HASH_AMOUNT_LKR,
        currency: 'LKR',
        merchantSecret: this.settings.merchantSecret,
      }),
    };
    return {
      method: 'POST',
      action: this.settings.preapprovalUrl,
      fields,
    };
  }

  verifyPreapproval(fields: Record<string, string>) {
    return parsePreapprovalNotification(fields, {
      merchantId: this.settings.merchantId,
      merchantSecret: this.settings.merchantSecret,
    });
  }

  verifyNotification(
    fields: Record<string, string>,
  ): ParsedPayHereNotification {
    return parsePayHereNotification(fields, {
      merchantId: this.settings.merchantId,
      merchantSecret: this.settings.merchantSecret,
    });
  }

  async verifyNotify(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<ParsedPayHereNotification> {
    return this.verifyNotification(formFields(rawBody));
  }

  async verifyByReference(
    merchantReference: string,
    expected?: {
      amount: string;
      currency: string;
      providerPaymentId?: string;
    },
    options?: { reason?: PayHereRetrievalReason },
  ): Promise<VerifyByReferenceResult> {
    const reason = options?.reason ?? 'post_charge';
    if (!expected?.amount || !expected.currency) {
      return { success: false, pending: true };
    }
    let payload: {
      status?: number;
      data?: RetrievalRow[] | null;
    };
    try {
      payload = await this.search(merchantReference, reason);
    } catch {
      return { success: false, pending: true };
    }
    if (payload.status === 0) {
      return { success: false, pending: true };
    }
    if (payload.status !== 1 || !Array.isArray(payload.data)) {
      return { success: false, pending: false };
    }
    const received = payload.data.filter(
      (row) =>
        row.order_id === merchantReference &&
        row.status === 'RECEIVED' &&
        row.currency === expected.currency &&
        amountsEqual(row.amount, expected.amount),
    );
    if (received.length > 1) {
      return { success: false, pending: true, ambiguous: true };
    }
    if (received.length === 1) {
      const row = received[0];
      const providerPaymentId = String(row.payment_id ?? '');
      if (
        !providerPaymentId ||
        (expected.providerPaymentId &&
          providerPaymentId !== expected.providerPaymentId)
      ) {
        return { success: false, pending: true };
      }
      return {
        success: true,
        pending: false,
        providerPaymentId,
        amount: formatPayHereAmount(String(row.amount)),
        currency: expected.currency,
      };
    }
    return { success: false, pending: true };
  }

  /** Visible for tests. A cached token is not logged or returned to callers. */
  async accessToken(now = Date.now()): Promise<string> {
    if (this.tokenCache && now < this.tokenCache.expiresAtMs) {
      return this.tokenCache.token;
    }
    this.reserveMerchantCall();
    const startedAtMs = Date.now();
    const authorization = Buffer.from(
      `${this.settings.appId}:${this.settings.appSecret}`,
    ).toString('base64');
    let response: Response;
    try {
      response = await this.fetchImpl(this.settings.oauthUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.warn({
        event: 'payhere.oauth.response_received',
        mode: this.settings.mode,
        success: false,
        httpStatus: null,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: payHereErrorCategory(error),
        errorName: payHereErrorName(error),
      });
      throw error;
    }
    if (!response.ok) {
      this.logger.warn({
        event: 'payhere.oauth.response_received',
        mode: this.settings.mode,
        success: false,
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: 'oauth_failed',
      });
      throw new Error('PayHere OAuth failed');
    }
    const json = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof json.access_token !== 'string' ||
      json.access_token === '' ||
      typeof json.expires_in !== 'number'
    ) {
      this.logger.warn({
        event: 'payhere.oauth.response_received',
        mode: this.settings.mode,
        success: false,
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: 'oauth_incomplete',
      });
      throw new Error('PayHere OAuth response was incomplete');
    }
    this.tokenCache = {
      token: json.access_token,
      expiresAtMs: now + json.expires_in * 1000 - 30_000,
    };
    this.logger.log({
      event: 'payhere.oauth.response_received',
      mode: this.settings.mode,
      success: true,
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAtMs,
    });
    return json.access_token;
  }

  private async search(
    orderId: string,
    reason: PayHereRetrievalReason,
  ): Promise<{
    status?: number;
    data?: RetrievalRow[] | null;
  }> {
    const startedAtMs = Date.now();
    const destination = payHereDestination(this.settings.retrievalUrl);
    this.logger.log({
      event: 'payhere.retrieval.request_started',
      merchantReference: orderId,
      reason,
      mode: this.settings.mode,
      hostname: destination.hostname,
      path: destination.path,
    });
    const tokenSource: 'fresh' | 'cache' =
      this.tokenCache && this.tokenCache.expiresAtMs > Date.now()
        ? 'cache'
        : 'fresh';
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      this.logger.warn({
        event: 'payhere.retrieval.request_error',
        merchantReference: orderId,
        reason,
        mode: this.settings.mode,
        httpStatus: null,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: payHereErrorCategory(error),
        errorName: payHereErrorName(error),
      });
      throw error;
    }
    this.reserveMerchantCall();
    const url = new URL(this.settings.retrievalUrl);
    url.searchParams.set('order_id', orderId);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.warn({
        event: 'payhere.retrieval.request_error',
        merchantReference: orderId,
        reason,
        mode: this.settings.mode,
        httpStatus: null,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: payHereErrorCategory(error),
        errorName: payHereErrorName(error),
      });
      throw error;
    }
    if (!response.ok) {
      // Diagnostics only: the body is read for the log, the outcome is unchanged.
      const body = await readPayHereResponseBody(response);
      this.logger.warn({
        event: 'payhere.retrieval.request_error',
        merchantReference: orderId,
        reason,
        mode: this.settings.mode,
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: 'retrieval_failed',
        errorName: 'Error',
        tokenSource,
        upstreamError: summarizePayHereErrorResponse(response, body, [
          token,
          ...this.secretValues(),
        ]),
      });
      throw new Error('PayHere retrieval failed');
    }
    const payload = (await response.json()) as {
      status?: number;
      data?: RetrievalRow[] | null;
    };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const matching = rows.filter((row) => row.order_id === orderId);
    const transactionStatus =
      matching.length === 1 ? matching[0].status ?? null : null;
    this.logger.log({
      event: 'payhere.retrieval.response_received',
      merchantReference: orderId,
      reason,
      mode: this.settings.mode,
      httpStatus: response.status,
      topLevelStatus: payload.status ?? null,
      matchingTransactionFound: matching.length > 0,
      matchingTransactionCount: matching.length,
      transactionStatus,
      referenceMatched: matching.length > 0,
      classification: classifyRetrieval(payload, matching.length),
      elapsedMs: Date.now() - startedAtMs,
    });
    return payload;
  }

  hasMerchantCapacity(needed = 1): boolean {
    this.pruneMerchantCalls();
    return this.merchantCallsAt.length + needed <= MERCHANT_RATE_LIMIT;
  }

  /**
   * Immediate capture of one saved-card token. `type` is PAYMENT.
   * The customer token is sent only in this request body and is never logged
   * or returned. A missing or mismatched md5sig is uncertain, not a success.
   * The Charging API shows md5sig; the construction checked here is the
   * documented checkout notification formula, which is not proof for this
   * response. `kind: 'reported'` still has to be confirmed by Retrieval.
   * `beforeDispatch` runs after OAuth and before the charge POST. A false
   * result means the POST is not sent.
   */
  async chargePayment(
    input: {
      orderId: string;
      amount: string;
      currency: string;
      customerToken: string;
    },
    options?: {
      beforeDispatch?: () => Promise<boolean>;
      /** Correlates charge logs with the local payment attempt. Never sent. */
      attemptId?: string;
    },
  ): Promise<PayHereChargeCall> {
    if (input.currency !== 'LKR' || !input.customerToken || !input.orderId) {
      throw new PayHereChargeNotSentError();
    }
    let amount: string;
    try {
      amount = formatPayHereAmount(input.amount);
    } catch {
      throw new PayHereChargeNotSentError();
    }
    const needsToken =
      !this.tokenCache || this.tokenCache.expiresAtMs <= Date.now();
    if (!this.hasMerchantCapacity(needsToken ? 2 : 1)) {
      throw new PayHereRateLimitError();
    }
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      if (error instanceof PayHereRateLimitError) throw error;
      throw new PayHereChargeNotSentError();
    }
    if (options?.beforeDispatch) {
      let allowed = false;
      try {
        allowed = await options.beforeDispatch();
      } catch {
        throw new PayHereChargeNotSentError();
      }
      if (!allowed) throw new PayHereChargeNotSentError();
    }
    this.reserveMerchantCall();
    const destination = payHereDestination(this.settings.chargeUrl);
    const startedAtMs = Date.now();
    this.logger.log({
      event: 'payhere.charge.request_started',
      attemptId: options?.attemptId ?? null,
      merchantReference: input.orderId,
      currency: 'LKR',
      amount,
      mode: this.settings.mode,
      hostname: destination.hostname,
      path: destination.path,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.settings.chargeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'PAYMENT',
          order_id: input.orderId,
          items: 'Welapathkade consultation',
          currency: 'LKR',
          amount: Number(amount),
          customer_token: input.customerToken,
          notify_url: this.settings.notifyUrl,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.warn({
        event: 'payhere.charge.request_error',
        attemptId: options?.attemptId ?? null,
        merchantReference: input.orderId,
        mode: this.settings.mode,
        httpStatus: null,
        elapsedMs: Date.now() - startedAtMs,
        errorCategory: payHereErrorCategory(error),
        errorName: payHereErrorName(error),
      });
      return { kind: 'uncertain' };
    }
    return this.readChargeResponse(response, input.orderId, amount, {
      attemptId: options?.attemptId,
      startedAtMs,
      tokenSource: needsToken ? 'fresh' : 'cache',
      redact: [token, input.customerToken, ...this.secretValues()],
    });
  }

  private async readChargeResponse(
    response: Response,
    orderId: string,
    amount: string,
    meta: {
      attemptId?: string;
      startedAtMs: number;
      tokenSource: 'fresh' | 'cache';
      redact: string[];
    },
  ): Promise<PayHereChargeCall> {
    // Set only for non-2xx responses. Successful log lines are unchanged.
    let upstreamError: PayHereUpstreamError | null = null;
    const finish = (
      result: PayHereChargeCall,
      details: {
        topLevelStatus: unknown;
        statusCode: number | null;
        providerPaymentId: string | null;
        signatureValid: boolean | null;
      },
    ): PayHereChargeCall => {
      const entry = {
        event: 'payhere.charge.response_received',
        attemptId: meta.attemptId ?? null,
        merchantReference: orderId,
        mode: this.settings.mode,
        httpStatus: response.status,
        topLevelStatus: details.topLevelStatus ?? null,
        statusCode: details.statusCode,
        providerPaymentId: details.providerPaymentId,
        signatureValid: details.signatureValid,
        classification: result.kind,
        elapsedMs: Date.now() - meta.startedAtMs,
      };
      if (upstreamError) {
        this.logger.warn({
          ...entry,
          tokenSource: meta.tokenSource,
          upstreamError,
        });
      } else {
        this.logger.log(entry);
      }
      return result;
    };
    let json: {
      status?: unknown;
      data?: unknown;
      error?: unknown;
    };
    if (!response.ok) {
      // Same parsed value as response.json(); the body is also summarized.
      const body = await readPayHereResponseBody(response);
      upstreamError = summarizePayHereErrorResponse(
        response,
        body,
        meta.redact,
      );
      if (body.format !== 'json') {
        return finish(
          { kind: 'uncertain' },
          {
            topLevelStatus: null,
            statusCode: null,
            providerPaymentId: null,
            signatureValid: null,
          },
        );
      }
      json = body.json as typeof json;
    } else {
      try {
        json = (await response.json()) as {
          status?: unknown;
          data?: unknown;
          error?: unknown;
        };
      } catch {
        return finish(
          { kind: 'uncertain' },
          {
            topLevelStatus: null,
            statusCode: null,
            providerPaymentId: null,
            signatureValid: null,
          },
        );
      }
    }
    const data = chargeData(json.data);
    const rawPaymentId =
      data?.payment_id === undefined || data?.payment_id === null
        ? null
        : String(data.payment_id);
    if (!response.ok) {
      if (json.error === 'invalid_token' && !data?.payment_id) {
        return finish(
          { kind: 'not-charged' },
          {
            topLevelStatus: json.status ?? null,
            statusCode: null,
            providerPaymentId: null,
            signatureValid: null,
          },
        );
      }
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status ?? null,
          statusCode: integerCode(data?.status_code),
          providerPaymentId: rawPaymentId,
          signatureValid: null,
        },
      );
    }
    if (
      (json.status === -1 || json.status === -2) &&
      (json.data === null || json.data === undefined)
    ) {
      return finish(
        { kind: 'not-charged' },
        {
          topLevelStatus: json.status,
          statusCode: null,
          providerPaymentId: null,
          signatureValid: null,
        },
      );
    }
    if (json.status !== 1 || !data) {
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status ?? null,
          statusCode: integerCode(data?.status_code),
          providerPaymentId: rawPaymentId,
          signatureValid: null,
        },
      );
    }
    if (data.order_id !== orderId || data.currency !== 'LKR') {
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status,
          statusCode: integerCode(data.status_code),
          providerPaymentId: rawPaymentId,
          signatureValid: null,
        },
      );
    }
    if (typeof data.amount !== 'string' && typeof data.amount !== 'number') {
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status,
          statusCode: integerCode(data.status_code),
          providerPaymentId: rawPaymentId,
          signatureValid: null,
        },
      );
    }
    if (!amountsEqual(data.amount, amount)) {
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status,
          statusCode: integerCode(data.status_code),
          providerPaymentId: rawPaymentId,
          signatureValid: null,
        },
      );
    }
    const statusCode = integerCode(data.status_code);
    if (statusCode === null) {
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status,
          statusCode: null,
          providerPaymentId: rawPaymentId,
          signatureValid: null,
        },
      );
    }
    const signatureValid = this.chargeSignatureOk(data, statusCode);
    if (!signatureValid) {
      return finish(
        { kind: 'uncertain' },
        {
          topLevelStatus: json.status,
          statusCode,
          providerPaymentId: rawPaymentId,
          signatureValid: false,
        },
      );
    }
    const providerPaymentId = rawPaymentId ?? '';
    if (statusCode === 2 && providerPaymentId) {
      return finish(
        {
          kind: 'reported',
          statusCode: 2,
          providerPaymentId,
          amount,
          currency: 'LKR',
        },
        {
          topLevelStatus: json.status,
          statusCode,
          providerPaymentId,
          signatureValid: true,
        },
      );
    }
    if (statusCode === 0) {
      return finish(
        providerPaymentId
          ? { kind: 'uncertain', providerPaymentId }
          : { kind: 'uncertain' },
        {
          topLevelStatus: json.status,
          statusCode,
          providerPaymentId: providerPaymentId || null,
          signatureValid: true,
        },
      );
    }
    if (statusCode === -1 || statusCode === -2) {
      return finish(
        { kind: 'declined', statusCode },
        {
          topLevelStatus: json.status,
          statusCode,
          providerPaymentId: providerPaymentId || null,
          signatureValid: true,
        },
      );
    }
    return finish(
      { kind: 'uncertain' },
      {
        topLevelStatus: json.status,
        statusCode,
        providerPaymentId: providerPaymentId || null,
        signatureValid: true,
      },
    );
  }

  private chargeSignatureOk(
    data: ChargeResponseData,
    statusCode: number,
  ): boolean {
    if (typeof data.md5sig !== 'string' || typeof data.order_id !== 'string') {
      return false;
    }
    if (typeof data.currency !== 'string' || data.amount === undefined) {
      return false;
    }
    let payhereAmount: string;
    try {
      payhereAmount = formatPayHereAmount(String(data.amount));
    } catch {
      return false;
    }
    const expected = notifySignature({
      merchantId: this.settings.merchantId,
      orderId: data.order_id,
      payhereAmount,
      payhereCurrency: data.currency,
      statusCode: String(statusCode),
      merchantSecret: this.settings.merchantSecret,
    });
    return signaturesMatch(expected, data.md5sig);
  }

  /**
   * Full refund of one captured PayHere payment. `amount` is omitted so PayHere
   * refunds the captured payment rather than a client-supplied figure.
   * `authorization_token` is not sent. Status 1 with a refund number means the
   * refund was processed. Status 0 and transport failures stay uncertain.
   */
  async refundPayment(
    paymentId: string,
    description: string,
  ): Promise<PayHereRefundCall> {
    const needsToken = !this.tokenCache || this.tokenCache.expiresAtMs <= Date.now();
    if (!this.hasMerchantCapacity(needsToken ? 2 : 1)) {
      throw new PayHereRateLimitError();
    }
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      if (error instanceof PayHereRateLimitError) throw error;
      throw new PayHereRefundNotSentError();
    }
    this.reserveMerchantCall();
    let response: Response;
    try {
      response = await this.fetchImpl(this.settings.refundUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payment_id: paymentIdBody(paymentId),
          description,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return {
        kind: 'uncertain',
        providerStatus: 0,
        message: 'PayHere refund request did not complete',
      };
    }
    if (!response.ok) {
      return {
        kind: 'uncertain',
        providerStatus: 0,
        message: 'PayHere refund HTTP response was not successful',
      };
    }
    let json: { status?: unknown; msg?: unknown; data?: unknown };
    try {
      json = (await response.json()) as {
        status?: unknown;
        msg?: unknown;
        data?: unknown;
      };
    } catch {
      return {
        kind: 'uncertain',
        providerStatus: 0,
        message: 'PayHere refund response could not be read',
      };
    }
    const providerStatus = typeof json.status === 'number' ? json.status : 0;
    const message = sanitizeProviderMessage(json.msg);
    if (providerStatus === 1) {
      const refundNumber = refundNumberFrom(json.data);
      if (!refundNumber) {
        return { kind: 'uncertain', providerStatus, message };
      }
      return { kind: 'started', refundNumber, providerStatus, message };
    }
    if (providerStatus === -1) {
      return { kind: 'failed', providerStatus, message };
    }
    return { kind: 'uncertain', providerStatus, message };
  }

  /**
   * Retrieval for one order id, then an exact `payment_id` match.
   * Rows for a different payment id are ignored. An empty or failed retrieval
   * stays unresolved.
   */
  async retrieveForRefund(
    orderId: string,
    paymentId: string,
  ): Promise<RetrievedRefundState> {
    let payload: { status?: number; data?: RetrievalRow[] | null };
    try {
      payload = await this.search(orderId, 'refund_lookup');
    } catch {
      return { kind: 'unavailable' };
    }
    if (payload.status !== 1 || !Array.isArray(payload.data)) {
      return { kind: 'unavailable' };
    }
    const matches = payload.data.filter(
      (row) => String(row.payment_id ?? '') === paymentId,
    );
    if (matches.length === 0) return { kind: 'not-this-payment' };
    if (matches.length > 1) return { kind: 'ambiguous' };
    const providerStatus = matches[0].status?.trim();
    if (!providerStatus) return { kind: 'ambiguous' };
    return { kind: 'matched', providerStatus };
  }

  /** Configured secret values that diagnostics must redact if echoed back. */
  private secretValues(): string[] {
    return [
      this.settings.merchantSecret,
      this.settings.appSecret,
      Buffer.from(`${this.settings.appId}:${this.settings.appSecret}`).toString(
        'base64',
      ),
    ];
  }

  private reserveMerchantCall() {
    this.pruneMerchantCalls();
    if (this.merchantCallsAt.length >= MERCHANT_RATE_LIMIT) {
      throw new PayHereRateLimitError();
    }
    this.merchantCallsAt.push(Date.now());
  }

  private pruneMerchantCalls() {
    const cutoff = Date.now() - MERCHANT_RATE_WINDOW_MS;
    while (this.merchantCallsAt.length > 0 && this.merchantCallsAt[0] <= cutoff) {
      this.merchantCallsAt.shift();
    }
  }
}

function formFields(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const fields: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (fields[key] !== undefined) {
      throw new Error('Malformed PayHere notification');
    }
    fields[key] = value;
  }
  return fields;
}

function paymentIdBody(paymentId: string): number | string {
  if (/^\d+$/.test(paymentId) && paymentId.length <= 15) {
    return Number(paymentId);
  }
  return paymentId;
}

function refundNumberFrom(data: unknown): string | null {
  if (typeof data === 'number' && Number.isSafeInteger(data)) {
    return String(data);
  }
  if (typeof data === 'string' && /^\d+$/.test(data)) return data;
  return null;
}

function sanitizeProviderMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/bearer\s+\S+/gi, 'bearer [redacted]').slice(0, 500);
}

function amountsEqual(
  received: number | string | undefined,
  expected: string,
): boolean {
  if (received === undefined) return false;
  try {
    return new Prisma.Decimal(received).equals(new Prisma.Decimal(expected));
  } catch {
    return false;
  }
}

type ChargeResponseData = {
  order_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  payment_id?: unknown;
  status_code?: unknown;
  md5sig?: unknown;
};

function chargeData(value: unknown): ChargeResponseData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ChargeResponseData;
}

function integerCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function classifyRetrieval(
  payload: { status?: number; data?: RetrievalRow[] | null },
  matchingCount: number,
): string {
  if (payload.status === 0) return 'pending';
  if (payload.status !== 1 || !Array.isArray(payload.data)) return 'unavailable';
  if (matchingCount === 0) return 'empty';
  if (matchingCount > 1) return 'ambiguous';
  return 'matched';
}

import {
  payHereDestination,
  payHereErrorCategory,
  payHereLogContainsForbidden,
} from './payhere-diagnostics';
import { PayHereGateway } from './payhere.gateway';
import { notifySignature, PayHereNotificationError } from './payhere-signature';

const SECRET = 'merchant-secret';
const MERCHANT_ID = '1210001';
const CUSTOMER_TOKEN = 'SECRET-CUSTOMER-TOKEN';
const OAUTH_TOKEN = 'oauth-access-secret';
const APP_SECRET = 'app-secret';

function settings() {
  return {
    mode: 'sandbox' as const,
    merchantId: MERCHANT_ID,
    merchantSecret: SECRET,
    checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
    oauthUrl: 'https://sandbox.payhere.lk/merchant/v1/oauth/token',
    retrievalUrl: 'https://sandbox.payhere.lk/merchant/v1/payment/search',
    refundUrl: 'https://sandbox.payhere.lk/merchant/v1/payment/refund',
    preapprovalUrl: 'https://sandbox.payhere.lk/pay/preapprove',
    chargeUrl: 'https://sandbox.payhere.lk/merchant/v1/payment/charge',
    appId: 'app-id',
    appSecret: APP_SECRET,
    notifyUrl: 'https://api.example.com/payments/callbacks/payhere',
    returnUrl: 'https://app.example.com/payments/return',
    cancelUrl: 'https://app.example.com/payments/cancel',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function captureLogger() {
  const entries: Array<{ level: string; payload: Record<string, unknown> }> =
    [];
  const sink = {
    log: (message: unknown) => {
      entries.push({ level: 'log', payload: message as Record<string, unknown> });
    },
    warn: (message: unknown) => {
      entries.push({
        level: 'warn',
        payload: message as Record<string, unknown>,
      });
    },
    error: (message: unknown) => {
      entries.push({
        level: 'error',
        payload: message as Record<string, unknown>,
      });
    },
  };
  return { sink, entries, rendered: () => JSON.stringify(entries) };
}

function signed(orderId: string, statusCode: string, amount = '1500.00') {
  return notifySignature({
    merchantId: MERCHANT_ID,
    orderId,
    payhereAmount: amount,
    payhereCurrency: 'LKR',
    statusCode,
    merchantSecret: SECRET,
  });
}

function chargeFetch(chargeBody: unknown, status = 200) {
  return jest.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/oauth/token')) {
      return jsonResponse({
        access_token: OAUTH_TOKEN,
        expires_in: 599,
      });
    }
    if (href.includes('/payment/charge')) {
      return jsonResponse(chargeBody, status);
    }
    if (href.includes('/payment/search')) {
      return jsonResponse({ status: 1, data: [] });
    }
    throw new Error(`unexpected url ${href}`);
  });
}

describe('PayHere diagnostic helpers', () => {
  it('extracts hostname and path without the query string', () => {
    expect(
      payHereDestination(
        'https://sandbox.payhere.lk/merchant/v1/payment/search?order_id=sc_1',
      ),
    ).toEqual({
      hostname: 'sandbox.payhere.lk',
      path: '/merchant/v1/payment/search',
    });
  });

  it('classifies timeout and signature failures without exposing payloads', () => {
    expect(payHereErrorCategory(new Error('request timeout'))).toBe('timeout');
    expect(
      payHereErrorCategory(new PayHereNotificationError('Invalid signature')),
    ).toBe('invalid_signature');
  });
});

describe('PayHere charge diagnostics', () => {
  const orderId = 'sc_order_diag_1';
  const attemptId = 'attempt-diag-1';

  function assertSafe(rendered: string) {
    expect(
      payHereLogContainsForbidden(rendered, [
        CUSTOMER_TOKEN,
        OAUTH_TOKEN,
        SECRET,
        APP_SECRET,
        'Basic ',
      ]),
    ).toBeNull();
    expect(rendered).not.toContain(CUSTOMER_TOKEN);
    expect(rendered).not.toContain(OAUTH_TOKEN);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(APP_SECRET);
  }

  it('logs a successful reported charge response without secrets', async () => {
    const logs = captureLogger();
    const gateway = new PayHereGateway(
      settings(),
      chargeFetch({
        status: 1,
        data: {
          order_id: orderId,
          amount: 1500,
          currency: 'LKR',
          payment_id: 320025014001,
          status_code: 2,
          md5sig: signed(orderId, '2'),
        },
      }),
      logs.sink,
    );
    await gateway.chargePayment(
      {
        orderId,
        amount: '1500.00',
        currency: 'LKR',
        customerToken: CUSTOMER_TOKEN,
      },
      { attemptId },
    );
    const started = logs.entries.find(
      (row) => row.payload.event === 'payhere.charge.request_started',
    );
    const response = logs.entries.find(
      (row) => row.payload.event === 'payhere.charge.response_received',
    );
    expect(started?.payload).toMatchObject({
      attemptId,
      merchantReference: orderId,
      currency: 'LKR',
      amount: '1500.00',
      mode: 'sandbox',
      hostname: 'sandbox.payhere.lk',
      path: '/merchant/v1/payment/charge',
    });
    expect(response?.payload).toMatchObject({
      attemptId,
      merchantReference: orderId,
      httpStatus: 200,
      topLevelStatus: 1,
      statusCode: 2,
      providerPaymentId: '320025014001',
      signatureValid: true,
      classification: 'reported',
    });
    expect(logs.entries.some((row) => row.payload.event === 'payhere.oauth.response_received')).toBe(
      true,
    );
    assertSafe(logs.rendered());
  });

  it('logs a pending charge response as uncertain', async () => {
    const logs = captureLogger();
    const gateway = new PayHereGateway(
      settings(),
      chargeFetch({
        status: 1,
        data: {
          order_id: orderId,
          amount: 1500,
          currency: 'LKR',
          payment_id: 99,
          status_code: 0,
          md5sig: signed(orderId, '0'),
        },
      }),
      logs.sink,
    );
    await gateway.chargePayment({
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: CUSTOMER_TOKEN,
    });
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.charge.response_received',
      )?.payload,
    ).toMatchObject({
      statusCode: 0,
      classification: 'uncertain',
      signatureValid: true,
    });
    assertSafe(logs.rendered());
  });

  it('logs a declined charge response', async () => {
    const logs = captureLogger();
    const gateway = new PayHereGateway(
      settings(),
      chargeFetch({
        status: 1,
        data: {
          order_id: orderId,
          amount: 1500,
          currency: 'LKR',
          payment_id: 99,
          status_code: -1,
          md5sig: signed(orderId, '-1'),
        },
      }),
      logs.sink,
    );
    await gateway.chargePayment({
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: CUSTOMER_TOKEN,
    });
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.charge.response_received',
      )?.payload,
    ).toMatchObject({
      statusCode: -1,
      classification: 'declined',
    });
    assertSafe(logs.rendered());
  });

  it('logs an HTTP error response classification', async () => {
    const logs = captureLogger();
    const gateway = new PayHereGateway(
      settings(),
      chargeFetch({ error: 'server_error' }, 500),
      logs.sink,
    );
    await gateway.chargePayment({
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: CUSTOMER_TOKEN,
    });
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.charge.response_received',
      )?.payload,
    ).toMatchObject({
      httpStatus: 500,
      classification: 'uncertain',
    });
    assertSafe(logs.rendered());
  });

  it('logs a malformed charge body as uncertain', async () => {
    const logs = captureLogger();
    const fetchMock = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: OAUTH_TOKEN, expires_in: 599 });
      }
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      } as Response;
    });
    const gateway = new PayHereGateway(settings(), fetchMock, logs.sink);
    await gateway.chargePayment({
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: CUSTOMER_TOKEN,
    });
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.charge.response_received',
      )?.payload.classification,
    ).toBe('uncertain');
    assertSafe(logs.rendered());
  });

  it('logs a charge transport failure without secrets', async () => {
    const logs = captureLogger();
    const fetchMock = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: OAUTH_TOKEN, expires_in: 599 });
      }
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const gateway = new PayHereGateway(settings(), fetchMock, logs.sink);
    await gateway.chargePayment({
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: CUSTOMER_TOKEN,
    });
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.charge.request_error',
      )?.payload,
    ).toMatchObject({
      errorCategory: 'timeout',
      errorName: 'TimeoutError',
      merchantReference: orderId,
    });
    assertSafe(logs.rendered());
  });

  it('logs an empty retrieval result', async () => {
    const logs = captureLogger();
    const fetchMock = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: OAUTH_TOKEN, expires_in: 599 });
      }
      return jsonResponse({ status: 1, data: [] });
    });
    const gateway = new PayHereGateway(settings(), fetchMock, logs.sink);
    await gateway.verifyByReference(
      orderId,
      { amount: '1500.00', currency: 'LKR' },
      { reason: 'post_charge' },
    );
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.retrieval.request_started',
      )?.payload,
    ).toMatchObject({
      merchantReference: orderId,
      reason: 'post_charge',
      mode: 'sandbox',
    });
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.retrieval.response_received',
      )?.payload,
    ).toMatchObject({
      matchingTransactionFound: false,
      classification: 'empty',
    });
    assertSafe(logs.rendered());
  });

  it('logs a retrieval exception', async () => {
    const logs = captureLogger();
    const fetchMock = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: OAUTH_TOKEN, expires_in: 599 });
      }
      throw new Error('PayHere retrieval failed upstream');
    });
    const gateway = new PayHereGateway(settings(), fetchMock, logs.sink);
    await gateway.verifyByReference(
      orderId,
      { amount: '1500.00', currency: 'LKR' },
      { reason: 'manual_reconciliation' },
    );
    expect(
      logs.entries.find(
        (row) => row.payload.event === 'payhere.retrieval.request_error',
      )?.payload,
    ).toMatchObject({
      merchantReference: orderId,
      reason: 'manual_reconciliation',
      errorCategory: 'retrieval_failed',
    });
    assertSafe(logs.rendered());
  });
});

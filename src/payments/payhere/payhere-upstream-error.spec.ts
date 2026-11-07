import {
  payHereLogContainsForbidden,
  readPayHereResponseBody,
  sanitizePayHereText,
  summarizePayHereErrorResponse,
} from './payhere-diagnostics';
import { PayHereGateway } from './payhere.gateway';
import { notifySignature } from './payhere-signature';

const SECRET = 'merchant-secret';
const MERCHANT_ID = '1210001';
const CUSTOMER_TOKEN = 'SECRET-CUSTOMER-TOKEN';
const OAUTH_TOKEN = 'oauth-access-secret';
const APP_SECRET = 'app-secret';
const PAN = '4916217501611292';
const EMAIL = 'nimal@example.com';
const BASIC = Buffer.from(`app-id:${APP_SECRET}`).toString('base64');

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
    json: () => Promise.resolve(body),
  } as Response;
}

/** A real fetch Response, so headers and text() behave as in production. */
function upstream(
  body: string | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

type Entry = { level: string; payload: Record<string, unknown> };

function captureLogger() {
  const entries: Entry[] = [];
  const push = (level: string) => (message: unknown) => {
    entries.push({ level, payload: message as Record<string, unknown> });
  };
  return {
    sink: { log: push('log'), warn: push('warn'), error: push('error') },
    entries,
    rendered: () => JSON.stringify(entries),
    find: (event: string) => entries.find((row) => row.payload.event === event),
  };
}

function assertSafe(rendered: string) {
  for (const value of [
    CUSTOMER_TOKEN,
    OAUTH_TOKEN,
    SECRET,
    APP_SECRET,
    BASIC,
    PAN,
    EMAIL,
  ]) {
    expect(rendered).not.toContain(value);
  }
  expect(
    payHereLogContainsForbidden(rendered, [
      CUSTOMER_TOKEN,
      OAUTH_TOKEN,
      SECRET,
      APP_SECRET,
    ]),
  ).toBeNull();
}

const orderId = 'sc_order_upstream_1';
const attemptId = 'attempt-upstream-1';

function gatewayWith(
  respond: (href: string) => Response,
  logs: ReturnType<typeof captureLogger>,
) {
  const fetchMock = jest.fn((url: string | URL) => {
    const href = String(url);
    if (href.includes('/oauth/token')) {
      return Promise.resolve(
        jsonResponse({ access_token: OAUTH_TOKEN, expires_in: 599 }),
      );
    }
    return Promise.resolve(respond(href));
  });
  return {
    fetchMock,
    gateway: new PayHereGateway(settings(), fetchMock, logs.sink),
  };
}

function charge(gateway: PayHereGateway) {
  return gateway.chargePayment(
    {
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: CUSTOMER_TOKEN,
    },
    { attemptId },
  );
}

function retrieve(gateway: PayHereGateway) {
  return gateway.verifyByReference(
    orderId,
    { amount: '1500.00', currency: 'LKR' },
    { reason: 'manual_reconciliation' },
  );
}

describe('PayHere charge upstream error diagnostics', () => {
  it('logs PayHere error details for an HTTP 401 charge response', async () => {
    const logs = captureLogger();
    const { gateway, fetchMock } = gatewayWith(
      () =>
        upstream(
          JSON.stringify({
            error: 'invalid_token',
            error_description: `Invalid access token: ${OAUTH_TOKEN}`,
          }),
          401,
          {
            'content-type': 'application/json;charset=UTF-8',
            'www-authenticate': `Bearer realm="oauth", error="invalid_token", error_description="Invalid access token: ${OAUTH_TOKEN}"`,
            'x-request-id': 'req-abc-123',
            server: 'nginx',
          },
        ),
      logs,
    );

    const result = await charge(gateway);

    // Classification is unchanged and nothing upstream reaches the caller.
    expect(result).toEqual({ kind: 'not-charged' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const row = logs.find('payhere.charge.response_received');
    expect(row?.level).toBe('warn');
    expect(row?.payload).toMatchObject({
      attemptId,
      merchantReference: orderId,
      httpStatus: 401,
      classification: 'not-charged',
      tokenSource: 'fresh',
      upstreamError: {
        httpStatus: 401,
        bodyFormat: 'json',
        contentType: 'application/json;charset=UTF-8',
        errorCode: 'invalid_token',
        errorMessage: 'Invalid access token: [redacted]',
        errorType: null,
        bodyKeys: ['error', 'error_description'],
        authChallenge: {
          scheme: 'Bearer',
          error: 'invalid_token',
          errorDescription: 'Invalid access token: [redacted]',
          realm: 'oauth',
        },
        server: 'nginx',
        requestId: 'req-abc-123',
      },
    });
    assertSafe(logs.rendered());
  });

  it('logs a PayHere-style msg body on HTTP 401 and keeps the charge uncertain', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        upstream(
          JSON.stringify({
            status: -1,
            msg: 'Unauthorized request',
            type: 'AUTHENTICATION',
            data: null,
          }),
          401,
          { 'content-type': 'application/json' },
        ),
      logs,
    );
    await expect(charge(gateway)).resolves.toEqual({ kind: 'uncertain' });
    expect(
      logs.find('payhere.charge.response_received')?.payload,
    ).toMatchObject({
      topLevelStatus: -1,
      upstreamError: {
        httpStatus: 401,
        bodyStatus: -1,
        errorMessage: 'Unauthorized request',
        errorType: 'AUTHENTICATION',
        bodyKeys: ['status', 'msg', 'type', 'data'],
      },
    });
    assertSafe(logs.rendered());
  });

  it('reads a nested error object', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        upstream(
          JSON.stringify({
            error: { code: 'E401', message: 'Not allowed', type: 'auth' },
          }),
          401,
        ),
      logs,
    );
    await expect(charge(gateway)).resolves.toEqual({ kind: 'uncertain' });
    expect(
      logs.find('payhere.charge.response_received')?.payload.upstreamError,
    ).toMatchObject({
      errorCode: 'E401',
      errorMessage: 'Not allowed',
      errorType: 'auth',
    });
  });

  it('keeps a non-JSON HTTP 401 charge uncertain and summarizes plain text', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        upstream(`Unauthorized\n\tBearer ${OAUTH_TOKEN} rejected`, 401, {
          'content-type': 'text/plain',
        }),
      logs,
    );
    await expect(charge(gateway)).resolves.toEqual({ kind: 'uncertain' });
    expect(
      logs.find('payhere.charge.response_received')?.payload,
    ).toMatchObject({
      httpStatus: 401,
      classification: 'uncertain',
      topLevelStatus: null,
      upstreamError: {
        bodyFormat: 'non_json',
        nonJsonSummary: 'Unauthorized Bearer [redacted] rejected',
      },
    });
    assertSafe(logs.rendered());
  });

  it('excludes tokens, secrets, card data, and unlisted fields from the log', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        upstream(
          JSON.stringify({
            status: -1,
            msg: `Rejected token=${CUSTOMER_TOKEN} card ${PAN} for ${EMAIL} secret: ${SECRET} auth Basic ${BASIC} app ${APP_SECRET}`,
            customer_token: CUSTOMER_TOKEN,
            card_no: PAN,
            card_holder_name: 'N Perera',
            md5sig: 'ABCDEF0123456789ABCDEF0123456789',
            Authorization: `Bearer ${OAUTH_TOKEN}`,
            billing: { email: EMAIL },
            debug: 'internal-stack-trace-xyz',
            data: null,
          }),
          401,
        ),
      logs,
    );
    await expect(charge(gateway)).resolves.toEqual({ kind: 'uncertain' });
    const upstreamError = logs.find('payhere.charge.response_received')?.payload
      .upstreamError as Record<string, unknown>;
    expect(upstreamError.bodyKeys).toEqual(['status', 'msg', 'debug', 'data']);
    expect(typeof upstreamError.errorMessage).toBe('string');
    expect((upstreamError.errorMessage as string).length).toBeLessThanOrEqual(
      201,
    );
    const rendered = logs.rendered();
    expect(rendered).not.toContain('internal-stack-trace-xyz');
    expect(rendered).not.toContain('N Perera');
    expect(rendered).not.toContain('ABCDEF0123456789ABCDEF0123456789');
    assertSafe(rendered);
  });

  it('handles an empty HTTP 401 charge body', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(() => upstream(null, 401), logs);
    await expect(charge(gateway)).resolves.toEqual({ kind: 'uncertain' });
    expect(
      logs.find('payhere.charge.response_received')?.payload.upstreamError,
    ).toMatchObject({
      httpStatus: 401,
      bodyFormat: 'empty',
      bodyLength: 0,
      errorCode: null,
      errorMessage: null,
      errorType: null,
      bodyKeys: null,
      nonJsonSummary: null,
    });
  });

  it('handles an unreadable body on a response without headers', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        ({
          ok: false,
          status: 401,
          json: () => {
            return Promise.reject(new Error('stream broken'));
          },
        }) as unknown as Response,
      logs,
    );
    await expect(charge(gateway)).resolves.toEqual({ kind: 'uncertain' });
    expect(
      logs.find('payhere.charge.response_received')?.payload.upstreamError,
    ).toMatchObject({
      httpStatus: 401,
      bodyFormat: 'unreadable',
      contentType: null,
      server: null,
      requestId: null,
      authChallenge: null,
    });
  });

  it('leaves the successful charge log line unchanged', async () => {
    const logs = captureLogger();
    const md5sig = notifySignature({
      merchantId: MERCHANT_ID,
      orderId,
      payhereAmount: '1500.00',
      payhereCurrency: 'LKR',
      statusCode: '2',
      merchantSecret: SECRET,
    });
    const { gateway } = gatewayWith(
      () =>
        jsonResponse({
          status: 1,
          msg: 'ok',
          data: {
            order_id: orderId,
            payment_id: 320025071278,
            currency: 'LKR',
            amount: 1500,
            status_code: 2,
            md5sig,
          },
        }),
      logs,
    );
    await expect(charge(gateway)).resolves.toMatchObject({ kind: 'reported' });
    const row = logs.find('payhere.charge.response_received');
    expect(row?.level).toBe('log');
    expect(Object.keys(row!.payload).sort()).toEqual(
      [
        'event',
        'attemptId',
        'merchantReference',
        'mode',
        'httpStatus',
        'topLevelStatus',
        'statusCode',
        'providerPaymentId',
        'signatureValid',
        'classification',
        'elapsedMs',
      ].sort(),
    );
  });
});

describe('PayHere retrieval upstream error diagnostics', () => {
  it('logs PayHere error details for an HTTP 403 retrieval response', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        upstream(
          JSON.stringify({
            timestamp: '2026-11-07T00:00:00.000+0000',
            status: 403,
            error: 'Forbidden',
            message: 'Access Denied',
            path: '/merchant/v1/payment/search',
          }),
          403,
          { 'content-type': 'application/json', 'cf-ray': '8a1b2c3d4e5f-CMB' },
        ),
      logs,
    );

    const result = await retrieve(gateway);

    expect(result).toEqual({ success: false, pending: true });
    const row = logs.find('payhere.retrieval.request_error');
    expect(row?.level).toBe('warn');
    expect(row?.payload).toMatchObject({
      merchantReference: orderId,
      reason: 'manual_reconciliation',
      httpStatus: 403,
      errorCategory: 'retrieval_failed',
      tokenSource: 'fresh',
      upstreamError: {
        httpStatus: 403,
        bodyFormat: 'json',
        bodyStatus: 403,
        errorCode: 'Forbidden',
        errorMessage: 'Access Denied',
        bodyKeys: ['timestamp', 'status', 'error', 'message', 'path'],
        authChallenge: null,
        requestId: '8a1b2c3d4e5f-CMB',
      },
    });
    expect(logs.find('payhere.retrieval.response_received')).toBeUndefined();
    assertSafe(logs.rendered());
  });

  it('reports the OAuth token source as cache on a later retrieval', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () => upstream(JSON.stringify({ message: 'Access Denied' }), 403),
      logs,
    );
    await retrieve(gateway);
    await retrieve(gateway);
    const rows = logs.entries.filter(
      (row) => row.payload.event === 'payhere.retrieval.request_error',
    );
    expect(rows.map((row) => row.payload.tokenSource)).toEqual([
      'fresh',
      'cache',
    ]);
  });

  it('summarizes a non-JSON HTML 403 without logging the body', async () => {
    const logs = captureLogger();
    const html = [
      '<html><head><title>403 Forbidden</title>',
      `<script>var k="${OAUTH_TOKEN}";</script></head>`,
      '<body><h1>Forbidden</h1><p>internal-detail-xyz</p></body></html>',
    ].join('');
    const { gateway } = gatewayWith(
      () =>
        upstream(html, 403, {
          'content-type': 'text/html',
          server: 'cloudflare',
        }),
      logs,
    );
    await expect(retrieve(gateway)).resolves.toEqual({
      success: false,
      pending: true,
    });
    expect(
      logs.find('payhere.retrieval.request_error')?.payload.upstreamError,
    ).toMatchObject({
      bodyFormat: 'non_json',
      bodyLength: html.length,
      contentType: 'text/html',
      nonJsonSummary: '403 Forbidden',
      server: 'cloudflare',
      errorCode: null,
      errorMessage: null,
      bodyKeys: null,
    });
    expect(logs.rendered()).not.toContain('internal-detail-xyz');
    assertSafe(logs.rendered());
  });

  it('handles malformed JSON and scalar JSON bodies', async () => {
    const malformed = captureLogger();
    await retrieve(
      gatewayWith(
        () =>
          upstream('{"error": "Forbidden", "message": ', 403, {
            'content-type': 'application/json',
          }),
        malformed,
      ).gateway,
    );
    expect(
      malformed.find('payhere.retrieval.request_error')?.payload.upstreamError,
    ).toMatchObject({ bodyFormat: 'non_json', errorCode: null });

    const scalar = captureLogger();
    await retrieve(
      gatewayWith(() => upstream('"Access is denied"', 403), scalar).gateway,
    );
    expect(
      scalar.find('payhere.retrieval.request_error')?.payload.upstreamError,
    ).toMatchObject({
      bodyFormat: 'json',
      errorMessage: 'Access is denied',
      bodyKeys: null,
    });

    const nullBody = captureLogger();
    await retrieve(gatewayWith(() => upstream('null', 403), nullBody).gateway);
    expect(
      nullBody.find('payhere.retrieval.request_error')?.payload.upstreamError,
    ).toMatchObject({ bodyFormat: 'json', errorMessage: null });
  });

  it('caps and cleans long error messages', async () => {
    const logs = captureLogger();
    const { gateway } = gatewayWith(
      () =>
        upstream(
          JSON.stringify({
            message: `Denied\u0000\u001b ${'word '.repeat(200)}`,
          }),
          403,
        ),
      logs,
    );
    await retrieve(gateway);
    const message = (
      logs.find('payhere.retrieval.request_error')?.payload
        .upstreamError as Record<string, unknown>
    ).errorMessage as string;
    expect(message.startsWith('Denied word')).toBe(true);
    expect(message.length).toBe(201);
    expect(message.endsWith('…')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('PayHere upstream error helpers', () => {
  it('redacts known secrets and token-shaped values', () => {
    expect(sanitizePayHereText('token: abc123 ok')).toBe(
      'token: [redacted] ok',
    );
    expect(sanitizePayHereText(`x ${SECRET} y`, [SECRET])).toBe(
      'x [redacted] y',
    );
    expect(
      sanitizePayHereText('id 0b8f2a64-1c2d-4e5f-8a9b-0c1d2e3f4a5b end'),
    ).toBe('id [redacted] end');
    expect(sanitizePayHereText(`card ${PAN}`)).toBe('card [redacted-number]');
    expect(sanitizePayHereText({ message: 'x' })).toBeNull();
    expect(sanitizePayHereText('   ')).toBeNull();
  });

  it('never throws on unexpected response shapes', async () => {
    for (const response of [null, undefined, 42, {}, { text: 'nope' }]) {
      const body = await readPayHereResponseBody(response);
      expect(body.format).toBe('unreadable');
      expect(summarizePayHereErrorResponse(response, body)).toMatchObject({
        httpStatus: null,
        bodyFormat: 'unreadable',
      });
    }
    const throwingHeaders = {
      status: 403,
      headers: {
        get: () => {
          throw new Error('boom');
        },
      },
    };
    expect(
      summarizePayHereErrorResponse(throwingHeaders, {
        format: 'json',
        json: { message: 'Denied' },
        length: 20,
      }),
    ).toMatchObject({ httpStatus: 403, errorMessage: 'Denied' });
  });
});

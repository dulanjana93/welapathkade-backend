import { PayHereChargeNotSentError, PayHereGateway } from './payhere.gateway';
import {
  checkoutHash,
  formatPayHereAmount,
  notifySignature,
  parsePayHereNotification,
  parsePreapprovalNotification,
  PayHereNotificationError,
  PAYHERE_PREAPPROVAL_HASH_AMOUNT_LKR,
} from './payhere-signature';

const SECRET = 'merchant-secret';
const MERCHANT_ID = '1210001';

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
    appSecret: 'app-secret',
    notifyUrl: 'https://api.example.com/payments/callbacks/payhere',
    returnUrl: 'https://app.example.com/payments/return',
    cancelUrl: 'https://app.example.com/payments/cancel',
  };
}

describe('PayHere checkout hash', () => {
  it('matches the known test vector and formats the amount', () => {
    expect(formatPayHereAmount('1000')).toBe('1000.00');
    expect(formatPayHereAmount('1500.5')).toBe('1500.50');
    expect(
      checkoutHash({
        merchantId: MERCHANT_ID,
        orderId: 'ItemNo12345',
        amount: '1000',
        currency: 'LKR',
        merchantSecret: SECRET,
      }),
    ).toBe('AFEAE19C6591EEB7F52331F00246077A');
  });

  it('rejects an invalid amount', () => {
    expect(() => formatPayHereAmount('0')).toThrow(PayHereNotificationError);
    expect(() => formatPayHereAmount('nope')).toThrow(PayHereNotificationError);
  });

  it('rejects a checkout URL that does not match the mode', () => {
    expect(
      () =>
        new PayHereGateway({
          ...settings(),
          checkoutUrl: 'https://evil.example/pay/checkout',
        }),
    ).toThrow(/PAYHERE_CHECKOUT_URL/);
  });

  it('does not put the merchant secret in the checkout response', async () => {
    const gateway = new PayHereGateway(settings());
    const result = await gateway.createCheckout({
      merchantReference: 'wp_apt_1',
      amount: '1500',
      currency: 'LKR',
      appointmentId: 'apt-1',
      consultationId: 'c-1',
      customer: {
        id: 'u1',
        name: 'Nimal',
        phone: '+94771234567',
        firstName: 'Nimal',
        lastName: 'Perera',
        email: 'nimal@example.com',
        address: '12 Temple Road',
        city: 'Colombo',
        country: 'Sri Lanka',
      },
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(SECRET);
    expect(encoded).not.toContain('app-secret');
    const fields = result.checkout.fields as Record<string, string>;
    expect(fields.order_id).toBe('wp_apt_1');
    expect(fields.amount).toBe('1500.00');
    expect(fields.currency).toBe('LKR');
    expect(fields.hash).toBe(
      checkoutHash({
        merchantId: MERCHANT_ID,
        orderId: 'wp_apt_1',
        amount: '1500.00',
        currency: 'LKR',
        merchantSecret: SECRET,
      }),
    );
    expect(result.checkout.action).toBe(
      'https://sandbox.payhere.lk/pay/checkout',
    );
  });
});

describe('PayHere notification verification', () => {
  function fields(overrides: Record<string, string> = {}) {
    const base = {
      merchant_id: MERCHANT_ID,
      order_id: 'wp_apt_1',
      payment_id: '320025071278',
      payhere_amount: '1500.00',
      payhere_currency: 'LKR',
      status_code: '2',
      card_holder_name: 'N Perera',
      card_no: '************4564',
      card_expiry: '0127',
      md5sig: '',
    };
    const merged = { ...base, ...overrides };
    merged.md5sig =
      overrides.md5sig ??
      notifySignature({
        merchantId: merged.merchant_id,
        orderId: merged.order_id,
        payhereAmount: merged.payhere_amount,
        payhereCurrency: merged.payhere_currency,
        statusCode: merged.status_code,
        merchantSecret: SECRET,
      });
    return merged;
  }

  it('accepts a valid signature and drops card fields', () => {
    const parsed = parsePayHereNotification(fields(), {
      merchantId: MERCHANT_ID,
      merchantSecret: SECRET,
    });
    expect(parsed.outcome).toBe('success');
    expect(parsed.sanitized).not.toHaveProperty('card_no');
    expect(parsed.sanitized).not.toHaveProperty('card_holder_name');
    expect(parsed.sanitized).not.toHaveProperty('card_expiry');
    expect(parsed.sanitized).not.toHaveProperty('md5sig');
    expect(parsed.providerPaymentId).toBe('320025071278');
  });

  it('rejects an invalid signature', () => {
    expect(() =>
      parsePayHereNotification(fields({ md5sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), {
        merchantId: MERCHANT_ID,
        merchantSecret: SECRET,
      }),
    ).toThrow(/Invalid signature/);
  });

  it('rejects a tampered amount', () => {
    const signed = fields();
    signed.payhere_amount = '1.00';
    expect(() =>
      parsePayHereNotification(signed, {
        merchantId: MERCHANT_ID,
        merchantSecret: SECRET,
      }),
    ).toThrow(/Invalid signature/);
  });

  it('rejects a tampered status', () => {
    const signed = fields();
    signed.status_code = '-2';
    expect(() =>
      parsePayHereNotification(signed, {
        merchantId: MERCHANT_ID,
        merchantSecret: SECRET,
      }),
    ).toThrow(/Invalid signature/);
  });

  it('rejects the wrong merchant id', () => {
    expect(() =>
      parsePayHereNotification(fields({ merchant_id: '999' }), {
        merchantId: MERCHANT_ID,
        merchantSecret: SECRET,
      }),
    ).toThrow(/Incorrect merchant ID/);
  });

  it('rejects a bad currency before trusting the body', () => {
    const signed = fields({ payhere_currency: 'usd' });
    expect(() =>
      parsePayHereNotification(signed, {
        merchantId: MERCHANT_ID,
        merchantSecret: SECRET,
      }),
    ).toThrow(PayHereNotificationError);
  });

  it('rejects a malformed body', () => {
    expect(() =>
      parsePayHereNotification({ merchant_id: MERCHANT_ID }, {
        merchantId: MERCHANT_ID,
        merchantSecret: SECRET,
      }),
    ).toThrow(/Malformed/);
  });

  it.each([
    ['2', 'success'],
    ['0', 'pending'],
    ['-1', 'failed'],
    ['-2', 'failed'],
    ['-3', 'chargedback'],
  ])('maps status %s to %s', (status, outcome) => {
    const parsed = parsePayHereNotification(fields({ status_code: status }), {
      merchantId: MERCHANT_ID,
      merchantSecret: SECRET,
    });
    expect(parsed.outcome).toBe(outcome);
    expect(parsed.success).toBe(status === '2');
  });
});

describe('PayHere retrieval', () => {
  function jsonResponse(body: unknown, ok = true) {
    return {
      ok,
      json: async () => body,
    } as Response;
  }

  it('selects the matching payment and reuses the OAuth token', async () => {
    const fetchImpl = jest.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'token-1',
          token_type: 'bearer',
          expires_in: 599,
        });
      }
      return jsonResponse({
        status: 1,
        data: [
          {
            payment_id: 111,
            order_id: 'wp_apt_1',
            status: 'RECEIVED',
            currency: 'USD',
            amount: 1500,
          },
          {
            payment_id: 222,
            order_id: 'wp_apt_1',
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 1500,
          },
          {
            payment_id: 333,
            order_id: 'someone-else',
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 1500,
          },
        ],
      });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    const first = await gateway.verifyByReference('wp_apt_1', {
      amount: '1500.00',
      currency: 'LKR',
    });
    const second = await gateway.verifyByReference('wp_apt_1', {
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(first).toMatchObject({
      success: true,
      providerPaymentId: '222',
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(second.success).toBe(true);
    const oauthCalls = fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes('/oauth/token'),
    );
    expect(oauthCalls).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('token-1');
  });

  it('does not confirm when several matching payments are returned', async () => {
    const fetchImpl = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      return jsonResponse({
        status: 1,
        data: [
          {
            payment_id: 1,
            order_id: 'wp_apt_1',
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 1500,
          },
          {
            payment_id: 2,
            order_id: 'wp_apt_1',
            status: 'RECEIVED',
            currency: 'LKR',
            amount: '1500.00',
          },
        ],
      });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    const result = await gateway.verifyByReference('wp_apt_1', {
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(result.success).toBe(false);
    expect(result.ambiguous).toBe(true);
  });

  it('rejects a different amount or currency', async () => {
    const fetchImpl = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      return jsonResponse({
        status: 1,
        data: [
          {
            payment_id: 1,
            order_id: 'wp_apt_1',
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 10,
          },
        ],
      });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    const result = await gateway.verifyByReference('wp_apt_1', {
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(result.success).toBe(false);
  });

  it('keeps a pending retrieval unconfirmed', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ access_token: 'token-1', expires_in: 599, status: 0 }),
    );
    const gateway = new PayHereGateway(settings(), fetchImpl);
    const result = await gateway.verifyByReference('wp_apt_1', {
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(result.success).toBe(false);
    expect(result.pending).toBe(true);
  });

  it('does not turn a retrieval failure into success', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down token-1');
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    const result = await gateway.verifyByReference('wp_apt_1', {
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('token-1');
  });

  it('requests a new token after the cached one expires', async () => {
    let now = 1_000_000;
    const fetchImpl = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 60 });
      }
      return jsonResponse({ status: -1, data: null });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    await gateway.accessToken(now);
    await gateway.accessToken(now + 1_000);
    now += 120_000;
    await gateway.accessToken(now);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String(call[0]).includes('/oauth/token'),
      ),
    ).toHaveLength(2);
  });
});

describe('PayHere refund API', () => {
  function jsonResponse(body: unknown, ok = true) {
    return {
      ok,
      json: async () => body,
    } as Response;
  }

  it('posts payment_id and description and treats status 1 as a refund number', async () => {
    const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      expect(href).toBe('https://sandbox.payhere.lk/merchant/v1/payment/refund');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        payment_id: 320025014001,
        description: 'Welapathkade consultation refund',
      });
      expect(body.authorization_token).toBeUndefined();
      expect(body.amount).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('token-1');
      return jsonResponse({
        status: 1,
        msg: 'Refund is completely successfully',
        data: 560034010257,
      });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    await expect(
      gateway.refundPayment('320025014001', 'Welapathkade consultation refund'),
    ).resolves.toEqual({
      kind: 'started',
      refundNumber: '560034010257',
      providerStatus: 1,
      message: 'Refund is completely successfully',
    });
  });

  it('keeps status 0 and a dropped connection uncertain, and status -1 failed', async () => {
    const fetchImpl = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      return jsonResponse({ status: 0, msg: 'still working', data: null });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    await expect(gateway.refundPayment('99', 'Welapathkade consultation refund')).resolves.toMatchObject({
      kind: 'uncertain',
      providerStatus: 0,
    });

    fetchImpl.mockImplementation(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      throw new Error('socket hang up');
    });
    await expect(gateway.refundPayment('99', 'Welapathkade consultation refund')).resolves.toMatchObject({
      kind: 'uncertain',
    });

    fetchImpl.mockImplementation(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      return jsonResponse({ status: -1, msg: 'Refund failed', data: null });
    });
    await expect(gateway.refundPayment('99', 'Welapathkade consultation refund')).resolves.toMatchObject({
      kind: 'failed',
      providerStatus: -1,
    });
  });

  it('matches retrieval on payment id and ignores a different payment', async () => {
    const fetchImpl = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 599 });
      }
      return jsonResponse({
        status: 1,
        data: [
          { payment_id: 111, order_id: 'wp_apt_1', status: 'REFUNDED' },
          {
            payment_id: 320025014001,
            order_id: 'wp_apt_1',
            status: 'REFUND REQUESTED',
          },
        ],
      });
    });
    const gateway = new PayHereGateway(settings(), fetchImpl);
    await expect(
      gateway.retrieveForRefund('wp_apt_1', '320025014001'),
    ).resolves.toEqual({
      kind: 'matched',
      providerStatus: 'REFUND REQUESTED',
    });
    await expect(gateway.retrieveForRefund('wp_apt_1', '999')).resolves.toEqual({
      kind: 'not-this-payment',
    });
  });
});

describe('PayHere pre-approval', () => {
  it('posts the sandbox pre-approval form without an amount and hashes 10.00', () => {
    const gateway = new PayHereGateway(settings());
    const form = gateway.createPreapproval({
      merchantReference: 'pa_order_1',
      customer: {
        firstName: 'Nimal',
        lastName: 'Perera',
        email: 'nimal@example.com',
        phone: '+94771234567',
        address: '12 Temple Road',
        city: 'Colombo',
        country: 'Sri Lanka',
      },
    });
    expect(form.action).toBe('https://sandbox.payhere.lk/pay/preapprove');
    expect(form.fields.amount).toBeUndefined();
    expect(form.fields.hash).toBe(
      checkoutHash({
        merchantId: MERCHANT_ID,
        orderId: 'pa_order_1',
        amount: PAYHERE_PREAPPROVAL_HASH_AMOUNT_LKR,
        currency: 'LKR',
        merchantSecret: SECRET,
      }),
    );
    expect(JSON.stringify(form)).not.toContain(SECRET);
  });

  it('rejects a bad pre-approval signature and the wrong merchant', () => {
    const gateway = new PayHereGateway(settings());
    const fields = {
      merchant_id: MERCHANT_ID,
      order_id: 'pa_order_1',
      payhere_amount: '1.00',
      payhere_currency: 'LKR',
      status_code: '2',
      md5sig: '00',
      customer_token: '59AFEE022CC69CA39D325E1B59130862',
      card_no: '************4564',
      card_holder_name: 'Nimal',
      card_expiry: '0128',
    };
    expect(() => gateway.verifyPreapproval(fields)).toThrow(
      PayHereNotificationError,
    );
    expect(() =>
      gateway.verifyPreapproval({ ...fields, merchant_id: '999' }),
    ).toThrow(/merchant/i);
    const signed = {
      ...fields,
      md5sig: notifySignature({
        merchantId: MERCHANT_ID,
        orderId: 'pa_order_1',
        payhereAmount: '1.00',
        payhereCurrency: 'LKR',
        statusCode: '2',
        merchantSecret: SECRET,
      }),
    };
    const parsed = parsePreapprovalNotification(signed, {
      merchantId: MERCHANT_ID,
      merchantSecret: SECRET,
    });
    expect(parsed.customerToken).toBe('59AFEE022CC69CA39D325E1B59130862');
    expect(parsed.cardLast4).toBe('4564');
    expect(parsed.cardBrand).toBeNull();
    expect(JSON.stringify({ ...parsed, customerToken: undefined })).not.toContain(
      'Nimal',
    );
  });
});

describe('PayHere saved-card charge', () => {
  const token = 'SECRET-CUSTOMER-TOKEN';
  const orderId = 'sc_order_1';

  function jsonResponse(body: unknown, ok = true) {
    return { ok, status: ok ? 200 : 401, json: async () => body } as Response;
  }

  function signed(statusCode: string, amount = '1500.00') {
    return notifySignature({
      merchantId: MERCHANT_ID,
      orderId,
      payhereAmount: amount,
      payhereCurrency: 'LKR',
      statusCode,
      merchantSecret: SECRET,
    });
  }

  function fetchImpl(chargeBody: unknown, ok = true) {
    return jest.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'oauth-access-secret',
          token_type: 'bearer',
          expires_in: 599,
        });
      }
      expect(href).toBe('https://sandbox.payhere.lk/merchant/v1/payment/charge');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer oauth-access-secret',
      });
      return jsonResponse(chargeBody, ok);
    });
  }

  it('sends PAYMENT with the consultation amount and does not return the token', async () => {
    const fetchMock = fetchImpl({
      status: 1,
      msg: 'Success',
      data: {
        order_id: orderId,
        amount: 1500,
        currency: 'LKR',
        payment_id: 320025014001,
        status_code: 2,
        status_message: 'Successfully completed',
        md5sig: signed('2'),
      },
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new PayHereGateway(settings(), fetchMock);
    const result = await gateway.chargePayment({
      orderId,
      amount: '1500.00',
      currency: 'LKR',
      customerToken: token,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toEqual({
      type: 'PAYMENT',
      order_id: orderId,
      items: 'Welapathkade consultation',
      currency: 'LKR',
      amount: 1500,
      customer_token: token,
      notify_url: 'https://api.example.com/payments/callbacks/payhere',
    });
    expect(result).toEqual({
      kind: 'reported',
      statusCode: 2,
      providerPaymentId: '320025014001',
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('oauth-access-secret');
    expect(log.mock.calls.join(' ')).not.toContain(token);
    log.mockRestore();
  });

  it('does not confirm status 0, -1, or -2, or a bad signature', async () => {
    const cases = [
      { status_code: 0, kind: 'uncertain' },
      { status_code: -1, kind: 'declined' },
      { status_code: -2, kind: 'declined' },
    ] as const;
    for (const item of cases) {
      const gateway = new PayHereGateway(
        settings(),
        fetchImpl({
          status: 1,
          data: {
            order_id: orderId,
            amount: 1500,
            currency: 'LKR',
            payment_id: 99,
            status_code: item.status_code,
            md5sig: signed(String(item.status_code)),
          },
        }),
      );
      await expect(
        gateway.chargePayment({
          orderId,
          amount: '1500.00',
          currency: 'LKR',
          customerToken: token,
        }),
      ).resolves.toMatchObject({ kind: item.kind });
    }
    const bad = new PayHereGateway(
      settings(),
      fetchImpl({
        status: 1,
        data: {
          order_id: orderId,
          amount: 1500,
          currency: 'LKR',
          payment_id: 99,
          status_code: 2,
          md5sig: '00',
        },
      }),
    );
    await expect(
      bad.chargePayment({
        orderId,
        amount: '1500.00',
        currency: 'LKR',
        customerToken: token,
      }),
    ).resolves.toEqual({ kind: 'uncertain' });
  });

  it('treats a timeout as uncertain and a null-data rejection as not charged', async () => {
    const timeout = new PayHereGateway(
      settings(),
      jest.fn(async (url: string | URL) => {
        if (String(url).includes('/oauth/token')) {
          return jsonResponse({
            access_token: 'oauth-access-secret',
            expires_in: 599,
          });
        }
        throw new Error('timeout');
      }),
    );
    await expect(
      timeout.chargePayment({
        orderId,
        amount: '1500.00',
        currency: 'LKR',
        customerToken: token,
      }),
    ).resolves.toEqual({ kind: 'uncertain' });

    const rejected = new PayHereGateway(
      settings(),
      fetchImpl({ status: -1, msg: 'Invalid token', data: null }),
    );
    await expect(
      rejected.chargePayment({
        orderId,
        amount: '1500.00',
        currency: 'LKR',
        customerToken: token,
      }),
    ).resolves.toEqual({ kind: 'not-charged' });
  });

  it('matches a known payment id and leaves several rows ambiguous', async () => {
    const fetchMock = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'oauth-access-secret',
          expires_in: 599,
        });
      }
      return jsonResponse({
        status: 1,
        data: [
          {
            payment_id: 111,
            order_id: orderId,
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 1500,
          },
          {
            payment_id: 222,
            order_id: orderId,
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 1500,
          },
        ],
      });
    });
    const gateway = new PayHereGateway(settings(), fetchMock);
    await expect(
      gateway.verifyByReference(orderId, {
        amount: '1500.00',
        currency: 'LKR',
      }),
    ).resolves.toMatchObject({ success: false, ambiguous: true });
    await expect(
      gateway.verifyByReference(orderId, {
        amount: '1500.00',
        currency: 'LKR',
        providerPaymentId: '222',
      }),
    ).resolves.toMatchObject({ success: false, ambiguous: true });
  });

  it('does not confirm a chargeback, a currency mismatch, or a different payment id', async () => {
    const rows = [
      [
        {
          payment_id: 222,
          order_id: orderId,
          status: 'CHARGEBACKED',
          currency: 'LKR',
          amount: 1500,
        },
      ],
      [
        {
          payment_id: 222,
          order_id: orderId,
          status: 'RECEIVED',
          currency: 'USD',
          amount: 1500,
        },
      ],
      [
        {
          payment_id: 111,
          order_id: orderId,
          status: 'RECEIVED',
          currency: 'LKR',
          amount: 1500,
        },
      ],
    ];
    for (const data of rows) {
      const gateway = new PayHereGateway(
        settings(),
        jest.fn(async () =>
          jsonResponse({
            access_token: 'oauth-access-secret',
            expires_in: 599,
            status: 1,
            data,
          }),
        ),
      );
      await expect(
        gateway.verifyByReference(orderId, {
          amount: '1500.00',
          currency: 'LKR',
          providerPaymentId: '222',
        }),
      ).resolves.toMatchObject({ success: false });
    }
  });

  it('confirms exactly one RECEIVED payment and skips the charge when dispatch is denied', async () => {
    const fetchMock = jest.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'oauth-access-secret',
          expires_in: 599,
        });
      }
      return jsonResponse({
        status: 1,
        data: [
          {
            payment_id: 222,
            order_id: orderId,
            status: 'RECEIVED',
            currency: 'LKR',
            amount: 1500,
          },
        ],
      });
    });
    const gateway = new PayHereGateway(settings(), fetchMock);
    await expect(
      gateway.verifyByReference(orderId, {
        amount: '1500.00',
        currency: 'LKR',
        providerPaymentId: '222',
      }),
    ).resolves.toMatchObject({
      success: true,
      providerPaymentId: '222',
      amount: '1500.00',
      currency: 'LKR',
    });

    const denied = jest.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'oauth-access-secret',
          expires_in: 599,
        });
      }
      return jsonResponse({});
    });
    const blocked = new PayHereGateway(settings(), denied);
    await expect(
      blocked.chargePayment(
        {
          orderId,
          amount: '1500.00',
          currency: 'LKR',
          customerToken: token,
        },
        { beforeDispatch: async () => false },
      ),
    ).rejects.toBeInstanceOf(PayHereChargeNotSentError);
    expect(
      denied.mock.calls.some((call) => String(call[0]).includes('/payment/charge')),
    ).toBe(false);
  });
});

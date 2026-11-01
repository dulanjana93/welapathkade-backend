import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  buildNotifyLkBody,
  buildOtpSmsMessage,
  NOTIFY_LK_SEND_URL,
  NOTIFY_LK_TIMEOUT_MS,
  NotifySmsSender,
} from './notify-sms.sender';

const settings = {
  userId: 'notify-user',
  apiKey: 'notify-key',
  senderId: 'WelaPathKade',
};

const otp = {
  phone: '0771234567',
  code: '482913',
  purpose: 'LOGIN',
};

function successResponse(body: unknown = { status: 'success', data: 'Sent' }) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  };
}

function httpError(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

describe('NotifySmsSender', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

  afterEach(() => {
    warn.mockClear();
    error.mockClear();
    log.mockClear();
    debug.mockClear();
  });

  afterAll(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
    debug.mockRestore();
  });

  it('POSTs the OTP to the Notify.lk HTTPS endpoint with form fields', async () => {
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal);
    const fetchImpl = jest.fn().mockResolvedValue(successResponse());
    const sender = new NotifySmsSender(settings, fetchImpl);

    await sender.sendOtp(otp);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(NOTIFY_LK_SEND_URL);
    expect(url.startsWith('https://')).toBe(true);
    expect(url).not.toContain(settings.apiKey);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(timeout).toHaveBeenCalledWith(NOTIFY_LK_TIMEOUT_MS);
    const form = init.body as URLSearchParams;
    expect(form.get('user_id')).toBe(settings.userId);
    expect(form.get('api_key')).toBe(settings.apiKey);
    expect(form.get('sender_id')).toBe('WelaPathKade');
    expect(form.get('to')).toBe('94771234567');
    expect(form.get('message')).toBe(buildOtpSmsMessage(otp.code));
    expect(form.get('type')).toBeNull();
    timeout.mockRestore();
  });

  it.each(['0771234567', '+94771234567', '94771234567', '771234567'])(
    'formats %s as 94771234567',
    async (phone) => {
      const fetchImpl = jest.fn().mockResolvedValue(successResponse());
      await new NotifySmsSender(settings, fetchImpl).sendOtp({
        ...otp,
        phone,
      });
      const form = fetchImpl.mock.calls[0][1].body as URLSearchParams;
      expect(form.get('to')).toBe('94771234567');
      expect(form.get('sender_id')).toBe(settings.senderId);
    },
  );

  it('sets type=unicode only when the message is not ASCII', () => {
    const ascii = buildNotifyLkBody({
      ...settings,
      to: '94771234567',
      message: buildOtpSmsMessage('482913'),
    });
    expect(ascii.get('type')).toBeNull();

    const unicode = buildNotifyLkBody({
      ...settings,
      to: '94771234567',
      message: 'Welapathkade: කේතය 482913',
    });
    expect(unicode.get('type')).toBe('unicode');
    expect(unicode.get('message')).toBe('Welapathkade: කේතය 482913');
  });

  it('treats a successful provider response as a sent SMS', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(successResponse());
    await expect(
      new NotifySmsSender(settings, fetchImpl).sendOtp(otp),
    ).resolves.toBeUndefined();
  });

  it('rejects a provider failure response without returning the provider body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      successResponse({ status: 'error', data: `bad key ${settings.apiKey}` }),
    );
    const thrown = await sendFailure(fetchImpl);
    expect(thrown.message).toBe('SMS could not be sent');
    expect(thrown.message).not.toContain(settings.apiKey);
    expect(thrown.message).not.toContain(otp.code);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 500, 503])(
    'rejects HTTP %s without exposing the response body',
    async (status) => {
      const fetchImpl = jest.fn().mockResolvedValue(
        httpError(status, { status: 'error', data: settings.apiKey }),
      );
      const thrown = await sendFailure(fetchImpl);
      expect(thrown).toBeInstanceOf(ServiceUnavailableException);
      expect(thrown.getStatus()).toBe(503);
      expect(thrown.message).not.toContain(settings.apiKey);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a timeout or a network failure', async () => {
    const timeoutError = new Error('The operation timed out');
    timeoutError.name = 'TimeoutError';
    const timeoutFetch = jest.fn().mockRejectedValue(timeoutError);
    await expect(
      new NotifySmsSender(settings, timeoutFetch).sendOtp(otp),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const networkFetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      new NotifySmsSender(settings, networkFetch).sendOtp(otp),
    ).rejects.toThrow('SMS could not be sent');
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid recipient before any request', async () => {
    const fetchImpl = jest.fn();
    await expect(
      new NotifySmsSender(settings, fetchImpl).sendOtp({
        ...otp,
        phone: '123',
      }),
    ).rejects.toThrow('Invalid Sri Lankan phone number');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not log credentials or the OTP message', async () => {
    const leak = new Error(
      `request failed api_key=${settings.apiKey} code=${otp.code} ${buildOtpSmsMessage(otp.code)}`,
    );
    const fetchImpl = jest.fn().mockRejectedValue(leak);
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    let thrown: Error | undefined;
    try {
      await new NotifySmsSender(settings, fetchImpl).sendOtp(otp);
    } catch (error) {
      thrown = error as Error;
    }

    const written = [
      thrown?.message ?? '',
      ...warn.mock.calls.flat(),
      ...error.mock.calls.flat(),
      ...log.mock.calls.flat(),
      ...debug.mock.calls.flat(),
      ...consoleWarn.mock.calls.flat(),
      ...consoleError.mock.calls.flat(),
      ...consoleLog.mock.calls.flat(),
    ].join(' ');
    expect(written).not.toContain(settings.apiKey);
    expect(written).not.toContain(settings.userId);
    expect(written).not.toContain(otp.code);
    expect(written).not.toContain('verify your Welapathkade account');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    consoleWarn.mockRestore();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });
});

async function sendFailure(fetchImpl: jest.Mock): Promise<ServiceUnavailableException> {
  try {
    await new NotifySmsSender(settings, fetchImpl).sendOtp(otp);
  } catch (error) {
    return error as ServiceUnavailableException;
  }
  throw new Error('expected the send to fail');
}

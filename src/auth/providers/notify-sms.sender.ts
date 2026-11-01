import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { normalizePhone } from '../../common/phone/normalize-phone';
import {
  SendOtpSmsParams,
  SmsSender,
} from '../interfaces/sms-sender.interface';

/** Official Notify.lk send endpoint. POST so credentials stay out of the URL. */
export const NOTIFY_LK_SEND_URL = 'https://app.notify.lk/api/v1/send';

/** One attempt. A timed-out send is not retried, because the SMS may already have gone out. */
export const NOTIFY_LK_TIMEOUT_MS = 10_000;

const CLIENT_ERROR = 'SMS could not be sent';

export type NotifyLkSettings = {
  userId: string;
  apiKey: string;
  senderId: string;
};

export type NotifyLkBodyInput = NotifyLkSettings & {
  to: string;
  message: string;
};

/**
 * Sri Lankan mobiles are stored as E.164 (+947XXXXXXXX). Notify.lk expects
 * the same number without the leading plus (947XXXXXXXX).
 */
export function toNotifyLkPhone(phone: string): string {
  return normalizePhone(phone).slice(1);
}

/** ASCII OTP text. Brand name is included, as Notify.lk requires for delivery. */
export function buildOtpSmsMessage(code: string): string {
  return `Welapathkade: use code ${code} to verify your Welapathkade account. Do not share this code.`;
}

export function buildNotifyLkBody(input: NotifyLkBodyInput): URLSearchParams {
  const body = new URLSearchParams();
  body.set('user_id', input.userId);
  body.set('api_key', input.apiKey);
  body.set('sender_id', input.senderId);
  body.set('to', input.to);
  body.set('message', input.message);
  if (/[^\u0000-\u007F]/.test(input.message)) {
    body.set('type', 'unicode');
  }
  return body;
}

/**
 * Production SMS adapter. Independent of AuthService: it only sends the OTP
 * it is given. Development and test keep ConsoleSmsSender.
 */
export class NotifySmsSender implements SmsSender {
  private readonly logger = new Logger(NotifySmsSender.name);

  constructor(
    private readonly settings: NotifyLkSettings,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async sendOtp(params: SendOtpSmsParams): Promise<void> {
    await this.sendText(params.phone, buildOtpSmsMessage(params.code));
  }

  /**
   * One HTTPS POST. Callers choose the message. OTP delivery uses sendOtp,
   * which keeps the existing OTP wording.
   */
  async sendText(phone: string, message: string): Promise<void> {
    const to = toNotifyLkPhone(phone);
    const body = buildNotifyLkBody({
      ...this.settings,
      to,
      message,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(NOTIFY_LK_SEND_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(NOTIFY_LK_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      this.logger.warn('SMS send failed before a provider response');
      throw new ServiceUnavailableException(CLIENT_ERROR);
    }

    if (!response.ok) {
      this.logger.warn(`SMS send failed with HTTP ${response.status}`);
      throw new ServiceUnavailableException(CLIENT_ERROR);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.logger.warn('SMS send returned an unreadable response');
      throw new ServiceUnavailableException(CLIENT_ERROR);
    }

    if (!isNotifySuccess(payload)) {
      this.logger.warn('SMS provider rejected the send');
      throw new ServiceUnavailableException(CLIENT_ERROR);
    }
  }
}

function isNotifySuccess(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as { status?: unknown }).status === 'success';
}

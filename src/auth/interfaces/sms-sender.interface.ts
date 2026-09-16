export const SMS_SENDER = Symbol('SMS_SENDER');

export type SendOtpSmsParams = {
  phone: string;
  code: string;
  purpose: string;
};

export interface SmsSender {
  sendOtp(params: SendOtpSmsParams): Promise<void>;
  /** Optional test/dev helper. Must never be returned from HTTP APIs. */
  getLastCode?(phone: string): string | undefined;
}

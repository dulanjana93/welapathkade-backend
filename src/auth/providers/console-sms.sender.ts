import { Injectable, Logger } from '@nestjs/common';
import {
  SendOtpSmsParams,
  SmsSender,
} from '../interfaces/sms-sender.interface';

/**
 * Development/test SMS adapter (SMS gateway not wired yet).
 * Logs the OTP code to the Nest console so local/dev login works.
 * Keeps the last code in memory for tests. Never returned from HTTP APIs.
 */
@Injectable()
export class ConsoleSmsSender implements SmsSender {
  private readonly logger = new Logger(ConsoleSmsSender.name);
  private readonly lastCodes = new Map<string, string>();

  async sendOtp(params: SendOtpSmsParams): Promise<void> {
    this.lastCodes.set(params.phone, params.code);
    // Dev-only: plaintext OTP for console inspection until SMS is integrated.
    this.logger.warn(
      `[DEV OTP] phone=${params.phone} purpose=${params.purpose} code=${params.code}`,
    );
  }

  getLastCode(phone: string): string | undefined {
    return this.lastCodes.get(phone);
  }

  clear(): void {
    this.lastCodes.clear();
  }
}

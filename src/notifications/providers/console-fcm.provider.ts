import { Injectable, Logger } from '@nestjs/common';
import {
  maskToken,
  type FcmProvider,
  type FcmSendInput,
  type FcmSendResult,
} from '../fcm-provider.interface';

/**
 * Development provider: logs that a push would have been sent.
 * Sends nothing, so it reports SKIPPED (never SENT).
 * Logs the type and a token suffix only; never title/body or the full token.
 */
@Injectable()
export class ConsoleFcmProvider implements FcmProvider {
  private readonly logger = new Logger(ConsoleFcmProvider.name);

  send(input: FcmSendInput): Promise<FcmSendResult> {
    this.logger.log(
      `[DEV FCM] not sent type=${input.data.type ?? 'unknown'} token=${maskToken(input.token)}`,
    );
    return Promise.resolve({ status: 'SKIPPED' });
  }
}

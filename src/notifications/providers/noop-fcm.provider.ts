import { Injectable } from '@nestjs/common';
import type { FcmProvider, FcmSendResult } from '../fcm-provider.interface';

/**
 * Silent, stateless provider for tests and for environments where no real
 * push provider is configured. Sends nothing and reports SKIPPED.
 */
@Injectable()
export class NoopFcmProvider implements FcmProvider {
  send(): Promise<FcmSendResult> {
    return Promise.resolve({ status: 'SKIPPED' });
  }
}

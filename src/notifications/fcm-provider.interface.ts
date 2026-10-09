export const FCM_PROVIDER = Symbol('FCM_PROVIDER');

export type FcmSendInput = {
  /** Device registration token. Secret: never log it in full. */
  token: string;
  title: string;
  body: string;
  /** FCM data values must be strings. Routing ids only. */
  data: Record<string, string>;
};

/**
 * Outcome of one device send.
 *
 * - SENT: the push service accepted the message (still not proof the user saw it).
 * - SKIPPED: nothing was sent (console/no-op provider, delivery disabled).
 *   Must never be treated as delivered.
 * - FAILED: the provider tried and failed.
 */
export type FcmSendResult =
  | { status: 'SENT' }
  | { status: 'SKIPPED' }
  | {
      status: 'FAILED';
      /** True only for definitive "token unregistered/invalid" errors. */
      invalidToken: boolean;
      /** True for transient errors worth a later retry. */
      retryable: boolean;
      /** Short provider error code. Must not contain the token or payload. */
      error: string;
    };

export interface FcmProvider {
  /** Implementations must not throw for expected delivery failures. */
  send(input: FcmSendInput): Promise<FcmSendResult>;
}

export type FcmProviderKind = 'console' | 'noop';

export const FCM_PROVIDER_KINDS: readonly FcmProviderKind[] = [
  'console',
  'noop',
];

/**
 * Picks the provider without requiring Firebase credentials.
 * Explicit config wins; otherwise development logs and test/production
 * stay silent (production has no real provider until a later phase).
 */
export function resolveFcmProviderKind(
  configured: string | undefined,
  nodeEnv: string | undefined,
): FcmProviderKind {
  const value = configured?.trim().toLowerCase();
  if (value && (FCM_PROVIDER_KINDS as readonly string[]).includes(value)) {
    return value as FcmProviderKind;
  }
  return nodeEnv === 'development' ? 'console' : 'noop';
}

/** Last characters only, for diagnostics. Never log the full token. */
export function maskToken(token: string): string {
  return token.length <= 6 ? '***' : `…${token.slice(-6)}`;
}

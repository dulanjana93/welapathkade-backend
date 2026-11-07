import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Logger } from '@nestjs/common';
import type { PayHereLogSink } from './payhere-diagnostics';

export const PAYHERE_FILE_LOG = 'PAYHERE_FILE_LOG';

/** Default on hosted Linux. Override with PAYHERE_LOG_PATH. */
export const DEFAULT_PAYHERE_LOG_PATH = '/var/log/welapathkade/payhere.log';

export function resolvePayHereLogPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PAYHERE_LOG_PATH?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_PAYHERE_LOG_PATH;
}

function payHerePayload(
  message: unknown,
): Record<string, unknown> | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  const event = (message as { event?: unknown }).event;
  if (typeof event !== 'string' || !event.startsWith('payhere.')) {
    return null;
  }
  return message as Record<string, unknown>;
}

/**
 * Append-only JSON-lines writer for PayHere diagnostics.
 * Write failures never throw into payment flows.
 */
export class PayHereFileLogSink {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  write(
    level: 'log' | 'warn' | 'error',
    message: unknown,
  ): void {
    const payload = payHerePayload(message);
    if (!payload) return;
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        ...payload,
      }) + '\n';
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line, { encoding: 'utf8' });
    } catch {
      // Diagnostics must never break OAuth, charge, retrieval, or notify.
    }
  }
}

/**
 * One Nest console line plus at most one JSON line in payhere.log.
 * Non-payhere messages stay console-only.
 */
export function createPayHereDiagnosticLogger(
  context: string,
  options?: {
    fileSink?: PayHereFileLogSink | null;
    nest?: Pick<Logger, 'log' | 'warn' | 'error'>;
  },
): PayHereLogSink {
  const nest = options?.nest ?? new Logger(context);
  const file =
    options && 'fileSink' in options && options.fileSink === null
      ? null
      : (options?.fileSink ??
        new PayHereFileLogSink(resolvePayHereLogPath()));

  return {
    log(message: unknown, ...optionalParams: unknown[]) {
      nest.log(message as never, ...(optionalParams as never[]));
      file?.write('log', message);
    },
    warn(message: unknown, ...optionalParams: unknown[]) {
      nest.warn(message as never, ...(optionalParams as never[]));
      file?.write('warn', message);
    },
    error(message: unknown, ...optionalParams: unknown[]) {
      nest.error(message as never, ...(optionalParams as never[]));
      file?.write('error', message);
    },
  };
}

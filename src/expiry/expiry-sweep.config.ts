export const DEFAULT_EXPIRY_SWEEP_INTERVAL_SECONDS = 60;
export const MIN_EXPIRY_SWEEP_INTERVAL_SECONDS = 5;
export const MAX_EXPIRY_SWEEP_INTERVAL_SECONDS = 3600;

export type ExpirySweepConfig = { enabled: boolean; intervalMs: number };

/**
 * Resolves the sweeper settings.
 *
 * - `enabled`: an explicit `true`/`false` wins. Unset means on, except in the
 *   test environment where timers must never start by accident.
 * - `intervalSeconds`: default 60. A value outside 5-3600 (or not a whole
 *   number) throws, even though env validation already rejects it, so a bad
 *   value can never produce a hot loop.
 */
export function resolveExpirySweepConfig(input: {
  enabled?: string;
  intervalSeconds?: string | number;
  nodeEnv?: string;
}): ExpirySweepConfig {
  const raw = input.enabled?.trim().toLowerCase();
  let enabled: boolean;
  if (raw === 'true') enabled = true;
  else if (raw === 'false') enabled = false;
  else if (raw === undefined || raw === '') enabled = input.nodeEnv !== 'test';
  else
    throw new Error(
      `EXPIRY_SWEEP_ENABLED must be "true" or "false", got "${raw}"`,
    );

  let seconds = DEFAULT_EXPIRY_SWEEP_INTERVAL_SECONDS;
  if (
    input.intervalSeconds !== undefined &&
    String(input.intervalSeconds).trim() !== ''
  ) {
    seconds = Number(input.intervalSeconds);
    if (
      !Number.isInteger(seconds) ||
      seconds < MIN_EXPIRY_SWEEP_INTERVAL_SECONDS ||
      seconds > MAX_EXPIRY_SWEEP_INTERVAL_SECONDS
    ) {
      throw new Error(
        `EXPIRY_SWEEP_INTERVAL_SECONDS must be a whole number between ${MIN_EXPIRY_SWEEP_INTERVAL_SECONDS} and ${MAX_EXPIRY_SWEEP_INTERVAL_SECONDS}`,
      );
    }
  }
  return { enabled, intervalMs: seconds * 1000 };
}

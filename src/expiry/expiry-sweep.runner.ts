import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveExpirySweepConfig } from './expiry-sweep.config';
import { ExpirySweepResult, ExpirySweepService } from './expiry-sweep.service';

/**
 * Runs the expiry sweep on a fixed interval inside the API process.
 *
 * - No dependency: a plain timer. It is `unref()`ed, so it alone never keeps
 *   the process alive.
 * - Disabled by default when NODE_ENV=test (see `resolveExpirySweepConfig`).
 * - Never overlaps itself within one process; a tick that finds a run in
 *   flight is skipped. Across processes overlap is harmless: every step is an
 *   idempotent, status-guarded UPDATE.
 * - Failures are logged, never thrown; the next tick is the retry.
 * - `onModuleDestroy` (triggered by `enableShutdownHooks`) clears the timer and
 *   waits for a run in flight, so it never races Prisma's disconnect.
 */
@Injectable()
export class ExpirySweepRunner
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExpirySweepRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ExpirySweepResult | null> | null = null;
  private stopped = false;

  constructor(
    private readonly sweep: ExpirySweepService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const settings = resolveExpirySweepConfig({
      enabled: this.config.get<string>('app.expirySweepEnabled'),
      intervalSeconds: this.config.get<string>(
        'app.expirySweepIntervalSeconds',
      ),
      nodeEnv: this.config.get<string>('app.nodeEnv'),
    });
    if (!settings.enabled) {
      this.logger.log('Expiry sweeper is disabled');
      return;
    }
    this.start(settings.intervalMs);
  }

  /** True while the interval timer is active. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(intervalMs: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    this.logger.log(`Expiry sweeper started (every ${intervalMs / 1000}s)`);
    // Catch up immediately after a start/restart; do not block bootstrap.
    void this.tick();
  }

  /**
   * One guarded run. Returns null when skipped (a run is in flight, or the
   * runner was stopped) or when the run failed unexpectedly.
   */
  async tick(now?: Date): Promise<ExpirySweepResult | null> {
    if (this.stopped || this.inFlight) return null;
    const run = this.execute(now);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let a run in flight finish before the database connection closes.
    await this.inFlight?.catch(() => undefined);
  }

  private async execute(now?: Date): Promise<ExpirySweepResult | null> {
    try {
      const result = await this.sweep.runOnce(now);
      if (result.errors.length > 0) {
        this.logger.warn(
          `Expiry sweep finished with errors (will retry next run): ${result.errors.join('; ')}`,
        );
      }
      if (
        result.reservations +
          result.payments +
          result.attempts +
          result.consultations +
          result.sessionsCompleted +
          result.financialSnapshotsCreated +
          result.financialLedgersPosted +
          result.abandonedUploadsRemoved >
        0
      ) {
        this.logger.log(
          `Expired ${result.reservations} reservation(s), ${result.payments} payment(s), ${result.attempts} attempt(s), ${result.consultations} request(s); completed ${result.sessionsCompleted} session(s); financial snapshots ${result.financialSnapshotsCreated}; ledgers posted ${result.financialLedgersPosted}; abandoned uploads removed ${result.abandonedUploadsRemoved}`,
        );
      }
      return result;
    } catch (error) {
      this.logger.error(
        `Expiry sweep failed (will retry next run): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

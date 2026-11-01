import { Logger } from '@nestjs/common';
import { ExpirySweepRunner } from './expiry-sweep.runner';
import type { ExpirySweepResult } from './expiry-sweep.service';

const emptyResult: ExpirySweepResult = {
  reservations: 0,
  payments: 0,
  attempts: 0,
  consultations: 0,
  sessionsCompleted: 0,
  financialSnapshotsCreated: 0,
  financialLedgersPosted: 0,
  abandonedUploadsRemoved: 0,
  refundsStarted: 0,
  refundsReconciled: 0,
  chargesReconciled: 0,
  errors: [],
};

function build(settings: Record<string, string | undefined>) {
  const sweep = { runOnce: jest.fn().mockResolvedValue(emptyResult) };
  const config = {
    get: (key: string) =>
      ({
        'app.expirySweepEnabled': settings.enabled,
        'app.expirySweepIntervalSeconds': settings.interval,
        'app.nodeEnv': settings.nodeEnv,
      })[key],
  };
  const runner = new ExpirySweepRunner(sweep as never, config as never);
  return { runner, sweep };
}

describe('ExpirySweepRunner', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('scheduling and configuration', () => {
    it('is disabled by default in the test environment: no timer, no sweep', async () => {
      const { runner, sweep } = build({ nodeEnv: 'test' });
      runner.onApplicationBootstrap();
      expect(runner.isRunning).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(sweep.runOnce).not.toHaveBeenCalled();
    });

    it('can be explicitly enabled in the test environment', async () => {
      const { runner, sweep } = build({ nodeEnv: 'test', enabled: 'true' });
      runner.onApplicationBootstrap();
      expect(runner.isRunning).toBe(true);
      await jest.advanceTimersByTimeAsync(0);
      expect(sweep.runOnce).toHaveBeenCalledTimes(1);
      await runner.onModuleDestroy();
    });

    it('can be explicitly disabled in development', () => {
      const { runner } = build({ nodeEnv: 'development', enabled: 'false' });
      runner.onApplicationBootstrap();
      expect(runner.isRunning).toBe(false);
    });

    it('runs once at start, then every 60 seconds by default', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(sweep.runOnce).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(59_999);
      expect(sweep.runOnce).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(sweep.runOnce).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(sweep.runOnce).toHaveBeenCalledTimes(3);
      await runner.onModuleDestroy();
    });

    it('honours a configured interval', async () => {
      const { runner, sweep } = build({
        nodeEnv: 'development',
        interval: '5',
      });
      runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(sweep.runOnce).toHaveBeenCalledTimes(2);
      await runner.onModuleDestroy();
    });

    it('refuses to start with an invalid interval', () => {
      const { runner } = build({ nodeEnv: 'development', interval: '1' });
      expect(() => runner.onApplicationBootstrap()).toThrow(
        /EXPIRY_SWEEP_INTERVAL_SECONDS/,
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('uses an unref()ed timer so it never keeps the process alive', () => {
      const spy = jest.spyOn(global, 'setInterval');
      const { runner } = build({ nodeEnv: 'development' });
      runner.onApplicationBootstrap();
      const timer = spy.mock.results[0].value as { hasRef(): boolean };
      expect(timer.hasRef()).toBe(false);
      void runner.onModuleDestroy();
    });
  });

  describe('overlap and failure handling', () => {
    it('never overlaps itself: a tick during a running sweep is skipped', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      let release!: (value: ExpirySweepResult) => void;
      sweep.runOnce.mockImplementationOnce(
        () => new Promise<ExpirySweepResult>((resolve) => (release = resolve)),
      );

      const first = runner.tick();
      expect(await runner.tick()).toBeNull(); // skipped
      expect(await runner.tick()).toBeNull(); // skipped
      expect(sweep.runOnce).toHaveBeenCalledTimes(1);

      release(emptyResult);
      expect(await first).toEqual(emptyResult);

      // The slot is free again afterwards.
      await runner.tick();
      expect(sweep.runOnce).toHaveBeenCalledTimes(2);
    });

    it('logs a failure without throwing and retries on the next tick', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      sweep.runOnce.mockRejectedValueOnce(new Error('connection lost'));

      await expect(runner.tick()).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection lost'),
      );

      sweep.runOnce.mockResolvedValueOnce({ ...emptyResult, consultations: 2 });
      await expect(runner.tick()).resolves.toMatchObject({ consultations: 2 });
    });

    it('logs step errors reported by the sweep as warnings', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      sweep.runOnce.mockResolvedValueOnce({
        ...emptyResult,
        errors: ['reservations: db down'],
      });
      await runner.tick();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('reservations: db down'),
      );
    });

    it('an interval tick that fails does not stop the schedule', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      sweep.runOnce.mockRejectedValue(new Error('boom'));
      runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(sweep.runOnce).toHaveBeenCalledTimes(3);
      expect(runner.isRunning).toBe(true);
      await runner.onModuleDestroy();
    });
  });

  describe('shutdown', () => {
    it('clears the timer and never ticks again', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(1);

      await runner.onModuleDestroy();

      expect(runner.isRunning).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      const calls = sweep.runOnce.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(sweep.runOnce).toHaveBeenCalledTimes(calls);
      expect(await runner.tick()).toBeNull();
    });

    it('waits for a sweep in flight before completing shutdown', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      let release!: (value: ExpirySweepResult) => void;
      sweep.runOnce.mockImplementationOnce(
        () => new Promise<ExpirySweepResult>((resolve) => (release = resolve)),
      );
      void runner.tick();

      let finished = false;
      const shutdown = runner.onModuleDestroy().then(() => (finished = true));
      await Promise.resolve();
      expect(finished).toBe(false);

      release(emptyResult);
      await shutdown;
      expect(finished).toBe(true);
    });

    it('shutdown tolerates a sweep that fails while in flight', async () => {
      const { runner, sweep } = build({ nodeEnv: 'development' });
      sweep.runOnce.mockRejectedValueOnce(new Error('late failure'));
      void runner.tick();
      await expect(runner.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('does not restart after shutdown', () => {
      const { runner } = build({ nodeEnv: 'development' });
      void runner.onModuleDestroy();
      runner.start(1000);
      expect(runner.isRunning).toBe(false);
    });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createPayHereDiagnosticLogger,
  PayHereFileLogSink,
  resolvePayHereLogPath,
} from './payhere-file-log.sink';
import { payHereLogContainsForbidden } from './payhere-diagnostics';

describe('PayHere file log sink', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'payhere-log-'));
    path = join(dir, 'payhere.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves PAYHERE_LOG_PATH over the Linux default', () => {
    expect(resolvePayHereLogPath({})).toBe('/var/log/welapathkade/payhere.log');
    expect(
      resolvePayHereLogPath({ PAYHERE_LOG_PATH: '  /tmp/custom-payhere.log  ' }),
    ).toBe('/tmp/custom-payhere.log');
  });

  it('writes one JSON line per payhere event and ignores other messages', () => {
    const sink = new PayHereFileLogSink(path);
    sink.write('log', {
      event: 'payhere.charge.request_started',
      merchantReference: 'sc_1',
    });
    sink.write('log', { event: 'other.system', hello: true });
    sink.write('warn', {
      event: 'payhere.charge.request_error',
      errorCategory: 'timeout',
    });

    const lines = readFileSync(path, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(first.event).toBe('payhere.charge.request_started');
    expect(first.level).toBe('log');
    expect(typeof first.ts).toBe('string');
    expect(second.event).toBe('payhere.charge.request_error');
    expect(second.level).toBe('warn');
  });

  it('does not throw when the file cannot be written', () => {
    const blocker = join(dir, 'blocker-file');
    writeFileSync(blocker, 'not-a-directory');
    const blocked = new PayHereFileLogSink(join(blocker, 'payhere.log'));
    expect(() =>
      blocked.write('log', { event: 'payhere.oauth.response_received' }),
    ).not.toThrow();
  });

  it('tees once to nest and once to the file without duplicate file lines', () => {
    const sink = new PayHereFileLogSink(path);
    const nest = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const logger = createPayHereDiagnosticLogger('Test', {
      fileSink: sink,
      nest,
    });
    logger.log({
      event: 'payhere.payment.finalized',
      attemptId: 'att-1',
      merchantReference: 'sc_1',
    });
    expect(nest.log).toHaveBeenCalledTimes(1);
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(payHereLogContainsForbidden(lines[0], ['SECRET'])).toBeNull();
  });
});

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FCM_PROVIDER,
  maskToken,
  resolveFcmProviderKind,
  type FcmProvider,
} from './fcm-provider.interface';
import { NotificationService } from './notification.service';
import { NotificationsModule } from './notifications.module';
import { ConsoleFcmProvider } from './providers/console-fcm.provider';
import { NoopFcmProvider } from './providers/noop-fcm.provider';
import { PrismaService } from '../prisma/prisma.service';

describe('resolveFcmProviderKind', () => {
  it('uses console in development and noop elsewhere by default', () => {
    expect(resolveFcmProviderKind(undefined, 'development')).toBe('console');
    expect(resolveFcmProviderKind(undefined, 'test')).toBe('noop');
    expect(resolveFcmProviderKind(undefined, 'production')).toBe('noop');
    expect(resolveFcmProviderKind(undefined, undefined)).toBe('noop');
  });

  it('honours an explicit valid setting (case-insensitive)', () => {
    expect(resolveFcmProviderKind('noop', 'development')).toBe('noop');
    expect(resolveFcmProviderKind(' Console ', 'production')).toBe('console');
  });

  it('falls back to the default for unknown values without throwing', () => {
    expect(resolveFcmProviderKind('firebase', 'development')).toBe('console');
    expect(resolveFcmProviderKind('', 'production')).toBe('noop');
  });
});

describe('maskToken', () => {
  it('exposes only a short suffix', () => {
    expect(maskToken('abcdefghijklmnop')).toBe('…klmnop');
    expect(maskToken('abc')).toBe('***');
  });
});

describe('NotificationsModule provider selection', () => {
  // NotificationsModule relies on the global ConfigModule/PrismaModule, so the
  // test supplies them as global stand-ins.
  function buildWithGlobals(env: { provider?: string; nodeEnv?: string }) {
    const config = {
      get: (key: string) =>
        key === 'app.notificationsFcmProvider'
          ? env.provider
          : key === 'app.nodeEnv'
            ? env.nodeEnv
            : undefined,
    };
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: {} },
      ],
      exports: [ConfigService, PrismaService],
    })
    class GlobalsStub {}
    return Test.createTestingModule({
      imports: [GlobalsStub, NotificationsModule],
    }).compile();
  }

  it('binds the console provider in development', async () => {
    const m = await buildWithGlobals({ nodeEnv: 'development' });
    expect(m.get<FcmProvider>(FCM_PROVIDER)).toBeInstanceOf(ConsoleFcmProvider);
  });

  it('binds the no-op provider in test and production without credentials', async () => {
    const t = await buildWithGlobals({ nodeEnv: 'test' });
    expect(t.get<FcmProvider>(FCM_PROVIDER)).toBeInstanceOf(NoopFcmProvider);
    const p = await buildWithGlobals({ nodeEnv: 'production' });
    expect(p.get<FcmProvider>(FCM_PROVIDER)).toBeInstanceOf(NoopFcmProvider);
  });

  it('lets an explicit setting override the environment default', async () => {
    const m = await buildWithGlobals({
      provider: 'noop',
      nodeEnv: 'development',
    });
    expect(m.get<FcmProvider>(FCM_PROVIDER)).toBeInstanceOf(NoopFcmProvider);
  });

  it('exposes a single NotificationService wired to the selected provider', async () => {
    const m = await buildWithGlobals({ nodeEnv: 'test' });
    expect(m.get(NotificationService)).toBeInstanceOf(NotificationService);
    expect(m.get(FCM_PROVIDER)).toBe(m.get(NoopFcmProvider));
  });
});

describe('FCM providers never claim delivery', () => {
  it('console provider reports SKIPPED and logs no full token or text', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((m: unknown) => void lines.push(String(m)));
    const result = await new ConsoleFcmProvider().send({
      token: 'secret-token-1234567890',
      title: 'Private title',
      body: 'Private body',
      data: { type: 'PROPOSAL_CREATED' },
    });
    spy.mockRestore();

    expect(result).toEqual({ status: 'SKIPPED' });
    const out = lines.join('\n');
    expect(out).not.toContain('secret-token-1234567890');
    expect(out).not.toContain('Private');
    expect(out).toContain('PROPOSAL_CREATED');
  });

  it('no-op provider reports SKIPPED', async () => {
    await expect(new NoopFcmProvider().send()).resolves.toEqual({
      status: 'SKIPPED',
    });
  });
});

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FCM_PROVIDER,
  resolveFcmProviderKind,
  type FcmProvider,
} from './fcm-provider.interface';
import { NotificationService } from './notification.service';
import { ConsoleFcmProvider } from './providers/console-fcm.provider';
import { NoopFcmProvider } from './providers/noop-fcm.provider';

/**
 * Phase 6B: persistence + provider abstraction only.
 * No business module imports this yet (Phase 6C), and no real FCM provider
 * exists (a later phase). PrismaModule and ConfigModule are global.
 */
@Module({
  providers: [
    NotificationService,
    ConsoleFcmProvider,
    NoopFcmProvider,
    {
      provide: FCM_PROVIDER,
      inject: [ConfigService, ConsoleFcmProvider, NoopFcmProvider],
      useFactory: (
        config: ConfigService,
        consoleProvider: ConsoleFcmProvider,
        noopProvider: NoopFcmProvider,
      ): FcmProvider => {
        const kind = resolveFcmProviderKind(
          config.get<string>('app.notificationsFcmProvider'),
          config.get<string>('app.nodeEnv'),
        );
        return kind === 'console' ? consoleProvider : noopProvider;
      },
    },
  ],
  exports: [NotificationService, FCM_PROVIDER],
})
export class NotificationsModule {}

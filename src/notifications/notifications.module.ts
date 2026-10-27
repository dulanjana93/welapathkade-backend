import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertFcmProviderAllowed } from '../config/runtime-safety';
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
        const nodeEnv = config.get<string>('app.nodeEnv');
        const kind = resolveFcmProviderKind(
          config.get<string>('app.notificationsFcmProvider'),
          nodeEnv,
        );
        // `console` logs notification activity: development-only (throws).
        // `noop` delivers nothing; allowed, but loudly flagged outside dev.
        const { warnNoDelivery } = assertFcmProviderAllowed(kind, nodeEnv);
        if (warnNoDelivery) {
          new Logger('NotificationsModule').warn(
            'No real push provider is configured: notifications are recorded but NOT delivered.',
          );
        }
        return kind === 'console' ? consoleProvider : noopProvider;
      },
    },
  ],
  exports: [NotificationService, FCM_PROVIDER],
})
export class NotificationsModule {}

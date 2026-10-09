import {
  Global,
  Injectable,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { FCM_PROVIDER, type FcmProvider } from './fcm-provider.interface';
import { NotificationService } from './notification.service';
import { NotificationsModule } from './notifications.module';

/**
 * Verifies, against the real Nest lifecycle, that in-flight deliveries are
 * awaited before the Prisma client disconnects on shutdown.
 */
describe('NotificationService shutdown ordering', () => {
  const events: string[] = [];

  @Injectable()
  class FakePrisma implements OnModuleDestroy {
    readonly notification = {
      findUnique: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        events.push('db-read');
        return null; // NOT_FOUND: delivery ends quickly after the read
      }),
    };

    onModuleDestroy() {
      events.push('prisma-disconnect');
    }
  }

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useClass: FakePrisma },
      { provide: ConfigService, useValue: { get: () => undefined } },
    ],
    exports: [PrismaService, ConfigService],
  })
  class GlobalsStub {}

  it('awaits pending deliveries before the database client is destroyed', async () => {
    events.length = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalsStub, NotificationsModule],
    }).compile();
    await moduleRef.init();

    const service = moduleRef.get(NotificationService);
    service.deliverAfterCommit(['n1']);
    await moduleRef.close();

    expect(events).toEqual(['db-read', 'prisma-disconnect']);
  });

  it('exposes the no-network provider (no Firebase) when nothing is configured', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalsStub, NotificationsModule],
    }).compile();
    const provider = moduleRef.get<FcmProvider>(FCM_PROVIDER);
    await expect(
      provider.send({ token: 't', title: 'x', body: 'y', data: {} }),
    ).resolves.toEqual({ status: 'SKIPPED' });
    await moduleRef.close();
  });
});

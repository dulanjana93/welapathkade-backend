import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Atomically INCR a key and EXPIRE it only when the counter becomes 1.
 * Implements a fixed window: TTL starts with the first hit and is not refreshed.
 * Returns the post-increment count. Errors propagate (callers fail closed).
 */
const INCR_FIXED_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.getOrThrow<string>('app.redisUrl');
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  getClient(): Redis {
    return this.client;
  }

  /**
   * Fixed-window counter: first hit sets TTL atomically with INCR via Lua.
   * Does not refresh expiry on subsequent hits.
   */
  async incrFixedWindow(key: string, windowSeconds: number): Promise<number> {
    const result = await this.client.eval(
      INCR_FIXED_WINDOW_LUA,
      1,
      key,
      String(windowSeconds),
    );
    const count = typeof result === 'number' ? result : Number(result);
    if (!Number.isFinite(count)) {
      throw new Error('Redis fixed-window INCR returned a non-numeric result');
    }
    return count;
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }
}

import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redisService: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const result = await this.redisService.ping();
      const isHealthy = result === 'PONG';
      const status = this.getStatus(key, isHealthy, { response: result });

      if (isHealthy) {
        return status;
      }

      throw new HealthCheckError('Redis check failed', status);
    } catch (error) {
      const status = this.getStatus(key, false, {
        message: error instanceof Error ? error.message : 'Unknown Redis error',
      });
      throw new HealthCheckError('Redis check failed', status);
    }
  }
}

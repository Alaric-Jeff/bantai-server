import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (configService: ConfigService) => {
    const host = configService.get<string>('REDIS_HOST', 'localhost');
    const port = Number(configService.get('REDIS_PORT', 6379));
    const password = configService.get<string>('REDIS_PASSWORD') || undefined;

    return new Redis({
      host,
      port,
      password,
      maxRetriesPerRequest: 3,
    });
  },
  inject: [ConfigService],
};

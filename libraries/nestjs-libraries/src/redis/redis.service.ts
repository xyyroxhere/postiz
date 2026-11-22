import { Redis } from 'ioredis';
import IORedisMock from 'ioredis-mock';

let redisInstance: any;

try {
  if (process.env.REDIS_URL && process.env.REDIS_URL !== 'mock') {
    redisInstance = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 3000,
      retryStrategy: (times) => {
        if (times > 3) {
          console.warn('[Redis] Local Redis not reachable, falling back to in-memory store');
          return null;
        }
        return Math.min(times * 100, 1000);
      },
    });
    redisInstance.on('error', (err: any) => {
      console.warn('[Redis warning]:', err?.message || err);
    });
  } else {
    redisInstance = new IORedisMock();
  }
} catch (e) {
  redisInstance = new IORedisMock();
}

export const ioRedis = redisInstance as unknown as Redis;

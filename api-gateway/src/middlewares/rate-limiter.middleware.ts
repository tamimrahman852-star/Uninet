/**
 * Per-route rate limiting. Counters live in Redis when REDIS_URL is configured so limits hold across
 * gateway replicas; without Redis the limit is per instance. A Redis outage never blocks traffic.
 */
import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import RedisStore, { type RedisReply } from 'rate-limit-redis';
import { sendError, type Handler } from './auth.middleware';

export interface RateLimitConfig {
  windowMs: number;
  limit: number;
}

const logger = new Logger('RateLimiter');

export function createRedisClient(url: string | undefined): Redis | undefined {
  if (!url) {
    logger.warn('REDIS_URL not set: rate limiting is per-instance only');
    return undefined;
  }
  const client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  client.on('error', (err: Error) => logger.error(`Redis error: ${err.message}`));
  return client;
}

export function createRateLimiter(name: string, config: RateLimitConfig, redis?: Redis): Handler {
  const limiter = rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
    store: redis
      ? new RedisStore({
          prefix: `rl:gateway:${name}:`,
          sendCommand: (...args: string[]) => {
            const [command, ...rest] = args;
            return redis.call(command, ...rest) as Promise<RedisReply>;
          },
        })
      : undefined,
    handler: (_req, res) => {
      sendError(res as Response, 429, 'rate_limited', 'Too many requests, slow down');
    },
  });
  return limiter as unknown as Handler;
}

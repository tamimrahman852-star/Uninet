/**
 * Flash-sale safe stock reservation and distributed locks on Redis.
 *
 * Model
 *   stock:<productId>          integer counter = DB stock minus active reservations
 *   reservation:<orderId>      hash productId -> qty held by that order
 *   reservations:expiry        sorted set orderId scored by expiry (ms)
 *
 * Reserving N items is ONE Lua script, so concurrent buyers can never oversell: either every line is
 * decremented or none is. Reservations that are never paid are returned to the pool by releaseExpired().
 * Note: release uses dynamic key names inside Lua, so this targets a single Redis node / primary.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

export interface ReserveLine {
  productId: string;
  quantity: number;
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'not_seeded' | 'insufficient'; productId: string };

const STOCK_PREFIX = 'stock:';
const RESERVATION_PREFIX = 'reservation:';
const EXPIRY_SET = 'reservations:expiry';

const RESERVE_SCRIPT = `
local resKey = KEYS[1]
local zKey = KEYS[2]
local orderId = ARGV[1]
local expiry = ARGV[2]
local n = #KEYS - 2
for i = 1, n do
  local cur = redis.call('GET', KEYS[i + 2])
  if not cur then return {1, i} end
  if tonumber(cur) < tonumber(ARGV[2 + i]) then return {2, i} end
end
for i = 1, n do
  redis.call('DECRBY', KEYS[i + 2], ARGV[2 + i])
  redis.call('HSET', resKey, ARGV[2 + n + i], ARGV[2 + i])
end
redis.call('ZADD', zKey, expiry, orderId)
return {0, 0}
`;

const RELEASE_SCRIPT = `
local items = redis.call('HGETALL', KEYS[1])
for i = 1, #items, 2 do
  redis.call('INCRBY', ARGV[2] .. items[i], items[i + 1])
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return #items / 2
`;

const COMMIT_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

const UNLOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Could not acquire lock ${key}`);
    this.name = 'LockTimeoutError';
  }
}

export class RedisLockService {
  constructor(private readonly redis: Redis) {}

  /** Initialises the counter from the DB value only when it does not exist yet. */
  async seedStock(productId: string, dbStock: number): Promise<void> {
    await this.redis.set(`${STOCK_PREFIX}${productId}`, String(dbStock), 'NX');
  }

  async getAvailable(productId: string): Promise<number | null> {
    const value = await this.redis.get(`${STOCK_PREFIX}${productId}`);
    return value === null ? null : Number(value);
  }

  /** Applies a signed delta (used when an admin changes stock) without disturbing reservations. */
  async adjustStock(productId: string, delta: number, dbStockAfter: number): Promise<void> {
    const key = `${STOCK_PREFIX}${productId}`;
    const exists = await this.redis.exists(key);
    if (exists) {
      await this.redis.incrby(key, delta);
    } else {
      await this.redis.set(key, String(dbStockAfter), 'NX');
    }
  }

  async reserve(orderId: string, lines: ReserveLine[], ttlSeconds: number): Promise<ReserveResult> {
    const stockKeys = lines.map((l) => `${STOCK_PREFIX}${l.productId}`);
    const expiryMs = Date.now() + ttlSeconds * 1000;
    const args = [orderId, String(expiryMs), ...lines.map((l) => String(l.quantity)), ...lines.map((l) => l.productId)];
    const result = (await this.redis.eval(
      RESERVE_SCRIPT,
      2 + stockKeys.length,
      `${RESERVATION_PREFIX}${orderId}`,
      EXPIRY_SET,
      ...stockKeys,
      ...args,
    )) as [number, number];

    const [status, index] = result;
    if (status === 0) return { ok: true };
    const productId = lines[index - 1]?.productId ?? '';
    return { ok: false, reason: status === 1 ? 'not_seeded' : 'insufficient', productId };
  }

  /** Payment succeeded: the DB now owns the decrement, so just forget the reservation. */
  async commit(orderId: string): Promise<void> {
    await this.redis.eval(COMMIT_SCRIPT, 2, `${RESERVATION_PREFIX}${orderId}`, EXPIRY_SET, orderId);
  }

  /** Order cancelled or expired: return held units to the pool. Returns the number of released lines. */
  async release(orderId: string): Promise<number> {
    const released = await this.redis.eval(
      RELEASE_SCRIPT,
      2,
      `${RESERVATION_PREFIX}${orderId}`,
      EXPIRY_SET,
      orderId,
      STOCK_PREFIX,
    );
    return Number(released);
  }

  /** Releases reservations whose TTL has elapsed and returns their order ids. */
  async releaseExpired(limit = 100): Promise<string[]> {
    const orderIds = await this.redis.zrangebyscore(EXPIRY_SET, '-inf', Date.now(), 'LIMIT', 0, limit);
    for (const orderId of orderIds) {
      await this.release(orderId);
    }
    return orderIds;
  }

  /** Runs fn while holding a lock; throws LockTimeoutError when it cannot be acquired within waitMs. */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>, waitMs = 5000): Promise<T> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') break;
      if (Date.now() >= deadline) throw new LockTimeoutError(key);
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 50)));
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(UNLOCK_SCRIPT, 1, lockKey, token).catch(() => undefined);
    }
  }

  /** Non-blocking variant for periodic jobs: returns undefined when another instance holds the lock. */
  async tryLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.withLock(key, ttlMs, fn, 0);
    } catch (err) {
      if (err instanceof LockTimeoutError) return undefined;
      throw err;
    }
  }
}

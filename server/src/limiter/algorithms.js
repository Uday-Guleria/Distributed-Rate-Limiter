import { randomUUID } from 'node:crypto';
import { registerScripts } from './scripts.js';

export const ALGORITHMS = ['fixed-window', 'sliding-window', 'token-bucket'];

/**
 * Runs one rate-limit check. Every algorithm is a single Lua script,
 * so the check-and-update is atomic across any number of app instances.
 *
 * Result: { allowed, limit, remaining, retryAfterMs, resetMs }
 */
export async function runAlgorithm(redis, algorithm, p) {
  registerScripts(redis);
  switch (algorithm) {
    case 'fixed-window': {
      const key = `rl:fw:${p.route}:${p.identity}`;
      const [ok, count, ttl] = await redis.rlFixedWindow(key, p.limit, p.windowMs);
      return {
        allowed: ok === 1,
        limit: p.limit,
        remaining: Math.max(0, p.limit - count),
        retryAfterMs: ok === 1 ? 0 : ttl,
        resetMs: ttl,
      };
    }
    case 'sliding-window': {
      const key = `rl:sw:${p.route}:${p.identity}`;
      const [ok, remaining, retry] = await redis.rlSlidingWindow(key, p.limit, p.windowMs, randomUUID());
      return {
        allowed: ok === 1,
        limit: p.limit,
        remaining,
        retryAfterMs: retry,
        resetMs: ok === 1 ? p.windowMs : retry,
      };
    }
    case 'token-bucket': {
      const key = `rl:tb:${p.route}:${p.identity}`;
      const cost = p.cost ?? 1;
      const [ok, tokens, retry] = await redis.rlTokenBucket(key, p.bucketSize, p.refillRatePerSec, cost);
      return {
        allowed: ok === 1,
        limit: p.bucketSize,
        remaining: tokens,
        retryAfterMs: retry,
        resetMs: retry,
      };
    }
    default:
      throw new Error(`Unknown algorithm: ${algorithm}`);
  }
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const luaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lua');
const load = (name) => readFileSync(path.join(luaDir, name), 'utf8');

/**
 * Registers the three Lua scripts as ioredis custom commands.
 * ioredis sends EVALSHA and transparently falls back to EVAL on NOSCRIPT,
 * so each check is a single atomic round trip.
 */
export function registerScripts(redis) {
  if (redis.rlFixedWindow) return redis;
  redis.defineCommand('rlFixedWindow', { numberOfKeys: 1, lua: load('fixedWindow.lua') });
  redis.defineCommand('rlSlidingWindow', { numberOfKeys: 1, lua: load('slidingWindow.lua') });
  redis.defineCommand('rlTokenBucket', { numberOfKeys: 1, lua: load('tokenBucket.lua') });
  return redis;
}

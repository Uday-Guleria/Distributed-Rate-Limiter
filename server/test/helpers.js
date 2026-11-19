import { randomUUID } from 'node:crypto';
import { createRedis, waitReady } from '../src/redis.js';
import { createApp } from '../src/app.js';
import { apiKeyIdentity, deriveIdentitySecret } from '../src/limiter/identity.js';

export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const SECRET = 'test-secret';
export const uid = (p = 't') => `${p}-${randomUUID().slice(0, 8)}`;
/** The identity the limiter derives for an x-api-key value (API keys are hashed, never stored raw). */
export const idFor = (key) => apiKeyIdentity(key, deriveIdentitySecret(SECRET));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startApp(extra = {}) {
  const redis = extra.redis ?? createRedis(REDIS_URL);
  if (!extra.noWait) await waitReady(redis);
  const app = createApp({ redis, jwtSecret: SECRET, ...extra });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    redis,
    async close() {
      await new Promise((r) => server.close(r));
      if (!extra.redis) redis.disconnect();
    },
  };
}

export async function get(base, path, headers = {}, method = 'GET') {
  const res = await fetch(base + path, { method, headers });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, headers: res.headers, body };
}

export async function adminToken(base) {
  return (await (await fetch(`${base}/dev/token?sub=root&role=admin`)).json()).token;
}

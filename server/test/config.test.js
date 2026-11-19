import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigCache } from '../src/config/configCache.js';
import { MemoryRulesRepo } from '../src/config/rulesRepo.js';
import { createRedis } from '../src/redis.js';
import { startApp, get, adminToken, uid, sleep, REDIS_URL } from './helpers.js';

const quiet = { warn() {} };
const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

test('ConfigCache: loads rules, refreshes on TTL, serves stale rules if the source fails', async () => {
  const repo = new MemoryRulesRepo([{ name: 'r', limit: 5 }]);
  const cache = new ConfigCache({ repo, ttlMs: 80, logger: quiet });
  await cache.start();
  cleanups.push(() => cache.stop());
  assert.equal(cache.get('r').limit, 5);

  await repo.upsert('r', { limit: 9 });
  await sleep(150);
  assert.equal(cache.get('r').limit, 9);

  repo.list = async () => { throw new Error('mongo down'); };
  await sleep(150);
  assert.equal(cache.get('r').limit, 9); // stale beats broken
});

test('ConfigCache: pub/sub invalidation refreshes immediately, long before the TTL', async () => {
  const repo = new MemoryRulesRepo([{ name: 'r', limit: 1 }]);
  const sub = createRedis(REDIS_URL, { enableOfflineQueue: true, maxRetriesPerRequest: null });
  const pub = createRedis(REDIS_URL);
  const cache = new ConfigCache({ repo, ttlMs: 60_000, subscriber: sub, logger: quiet });
  await cache.start();
  cleanups.push(async () => { await cache.stop(); sub.disconnect(); pub.disconnect(); });

  await repo.upsert('r', { limit: 77 });
  assert.equal(cache.get('r').limit, 1);
  await pub.publish('rl:config:invalidate', 'r');
  await sleep(150);
  assert.equal(cache.get('r').limit, 77);
});

test('admin API: rejects non-admins, validates input, and a rule change takes effect on the live limiter', async () => {
  const repo = new MemoryRulesRepo();
  const sub = createRedis(REDIS_URL, { enableOfflineQueue: true, maxRetriesPerRequest: null });
  const pub = createRedis(REDIS_URL);
  const configCache = await new ConfigCache({ repo, subscriber: sub, logger: quiet }).start();
  const srv = await startApp({ repo, configCache, publisher: pub });
  cleanups.push(async () => { await srv.close(); await configCache.stop(); sub.disconnect(); pub.disconnect(); });

  assert.equal((await get(srv.base, '/admin/rules')).status, 401);
  const admin = { authorization: `Bearer ${await adminToken(srv.base)}`, 'content-type': 'application/json' };
  const user = await (await fetch(`${srv.base}/dev/token?sub=joe`)).json();
  assert.equal((await get(srv.base, '/admin/rules', { authorization: `Bearer ${user.token}` })).status, 403);

  const bad = await fetch(`${srv.base}/admin/rules/public`, { method: 'PUT', headers: admin, body: JSON.stringify({ limit: -3 }) });
  assert.equal(bad.status, 400);

  const key = uid('key');
  for (let i = 0; i < 3; i++) assert.equal((await get(srv.base, '/api/public', { 'x-api-key': key })).status, 200);

  // Tighten the "public" route from 10 to 3 per window, live, no restart.
  const put = await fetch(`${srv.base}/admin/rules/public`, { method: 'PUT', headers: admin, body: JSON.stringify({ limit: 3 }) });
  assert.equal(put.status, 200);
  assert.equal((await get(srv.base, '/api/public', { 'x-api-key': key })).status, 429);

  // Disable the rule -> route is no longer limited.
  await fetch(`${srv.base}/admin/rules/public`, { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
  assert.equal((await get(srv.base, '/api/public', { 'x-api-key': key })).status, 200);
});

// ---------- effective-config validation (fix: algorithm changes need their own parameters) ----------
import { validateConfig, mergeConfig } from '../src/limiter/config.js';

test('validateConfig: every algorithm requires its own parameters', () => {
  assert.deepEqual(validateConfig({ algorithm: 'fixed-window', limit: 5, windowMs: 1000 }), []);
  assert.deepEqual(validateConfig({ algorithm: 'sliding-window', limit: 5, windowMs: 1000 }), []);
  assert.deepEqual(validateConfig({ algorithm: 'token-bucket', bucketSize: 5, refillRatePerSec: 1 }), []);
  assert.equal(validateConfig({ algorithm: 'token-bucket', limit: 5, windowMs: 1000 }).length, 2);
  assert.equal(validateConfig({ algorithm: 'fixed-window', bucketSize: 5, refillRatePerSec: 1 }).length, 2);
  assert.equal(validateConfig({ algorithm: 'fixed-window', limit: 1.5, windowMs: 1000 }).length, 1);
  assert.equal(validateConfig({ algorithm: 'bogus' }).length, 1);
});

test('mergeConfig: override wins over defaults, nulls and metadata are ignored', () => {
  const m = mergeConfig({ name: 'x', algorithm: 'fixed-window', limit: 10, windowMs: 1000 }, { name: 'x', _id: 1, limit: 3, windowMs: null, enabled: true });
  assert.equal(m.limit, 3);
  assert.equal(m.windowMs, 1000);
  assert.equal(m._id, undefined);
});

test('admin API: switching algorithm without its parameters is rejected, with them it works live', async () => {
  const repo = new MemoryRulesRepo();
  const configCache = await new ConfigCache({ repo, logger: quiet }).start();
  const srv = await startApp({ repo, configCache });
  cleanups.push(async () => { await srv.close(); await configCache.stop(); });
  const admin = { authorization: `Bearer ${await adminToken(srv.base)}`, 'content-type': 'application/json' };
  const put = (name, body) => fetch(`${srv.base}/admin/rules/${name}`, { method: 'PUT', headers: admin, body: JSON.stringify(body) });

  // /api/public is fixed-window with no bucket parameters: switching alone must fail.
  const bad = await put('public', { algorithm: 'token-bucket' });
  assert.equal(bad.status, 400);
  const msg = (await bad.json()).message;
  assert.match(msg, /bucketSize/);
  assert.match(msg, /refillRatePerSec/);
  assert.equal((await repo.list()).length, 0, 'nothing may be stored when validation fails');

  // Only one of the two parameters is still not enough.
  assert.equal((await put('public', { algorithm: 'token-bucket', bucketSize: 3 })).status, 400);

  // Supplying both works, and the limiter really switches algorithm.
  const ok = await put('public', { algorithm: 'token-bucket', bucketSize: 3, refillRatePerSec: 0.01 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).effective.algorithm, 'token-bucket');
  const key = uid('key');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await get(srv.base, '/api/public', { 'x-api-key': key })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);

  // The reverse direction: /api/spike is a token bucket without limit/windowMs.
  assert.equal((await put('spike', { algorithm: 'fixed-window' })).status, 400);
  assert.equal((await put('spike', { algorithm: 'fixed-window', limit: 2, windowMs: 60000 })).status, 200);
});

test('admin API: unknown route names are rejected instead of silently creating dead rules', async () => {
  const repo = new MemoryRulesRepo();
  const configCache = await new ConfigCache({ repo, logger: quiet }).start();
  const srv = await startApp({ repo, configCache });
  cleanups.push(async () => { await srv.close(); await configCache.stop(); });
  const admin = { authorization: `Bearer ${await adminToken(srv.base)}`, 'content-type': 'application/json' };
  const res = await fetch(`${srv.base}/admin/rules/nonexistent`, { method: 'PUT', headers: admin, body: JSON.stringify({ limit: 5 }) });
  assert.equal(res.status, 404);
  assert.match((await res.json()).message, /public/);
});

test('limiter ignores an invalid override already in the database and keeps serving with the defaults', async () => {
  // Simulates a rule written straight into Mongo, bypassing the admin API.
  const repo = new MemoryRulesRepo([{ name: 'public', algorithm: 'token-bucket' }]);
  const configCache = await new ConfigCache({ repo, logger: quiet }).start();
  const srv = await startApp({ repo, configCache });
  cleanups.push(async () => { await srv.close(); await configCache.stop(); });
  const warn = console.warn; console.warn = () => {};
  try {
    const key = uid('key');
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await get(srv.base, '/api/public', { 'x-api-key': key })).status);
    assert.equal(codes.filter((c) => c === 200).length, 10); // default fixed-window limit, no 500s, no bypass
    assert.equal(codes.filter((c) => c === 429).length, 2);
  } finally { console.warn = warn; }
});

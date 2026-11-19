import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis } from '../src/redis.js';
import { startApp, get, sleep } from './helpers.js';
import { detectRedisLauncher, launchRedis } from './redisLauncher.js';

const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

const launcher = detectRedisLauncher(); // 'binary' | 'docker' | null

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(50); }
  return false;
}

test('unreachable Redis: fail-open route serves traffic, fail-closed route returns 503, neither hangs', async () => {
  const dead = createRedis('redis://127.0.0.1:1', { retryStrategy: () => 5000 });
  const srv = await startApp({ redis: dead, commandTimeoutMs: 200, noWait: true });
  cleanups.push(async () => { await srv.close(); dead.disconnect(); });

  let t = Date.now();
  const open = await get(srv.base, '/api/public');
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('x-ratelimit-status'), 'bypassed');
  assert.ok(Date.now() - t < 1000, 'fail-open must not hang');

  t = Date.now();
  const closed = await get(srv.base, '/api/login', {}, 'POST');
  assert.equal(closed.status, 503);
  assert.equal(closed.body.error, 'rate_limiter_unavailable');
  assert.ok(Date.now() - t < 1000, 'fail-closed must not hang');
});

test(
  'chaos: kill a real Redis mid-run, both modes behave, both recover after restart',
  { skip: !launcher && 'needs `redis-server` on the PATH or a running Docker daemon', timeout: 180_000 },
  async () => {
    const port = 6391;
    let redisProc = launchRedis(launcher, port);
    cleanups.push(async () => redisProc.stop());

    const redis = createRedis(`redis://127.0.0.1:${port}`, { retryStrategy: () => 100 });
    assert.ok(await waitFor(async () => (await redis.ping()) === 'PONG', 30_000), 'redis should start');
    const srv = await startApp({ redis, commandTimeoutMs: 200 });
    cleanups.push(async () => { await srv.close(); redis.disconnect(); });

    assert.equal((await get(srv.base, '/api/public', { 'x-api-key': 'chaos-1' })).status, 200);
    assert.equal((await get(srv.base, '/api/login', { 'x-forwarded-for': '9.9.9.9' }, 'POST')).status, 200);

    redisProc.stop(); // hard kill, no graceful shutdown
    await sleep(500);

    assert.equal((await get(srv.base, '/api/public', { 'x-api-key': 'chaos-2' })).status, 200, 'fail-open serves during outage');
    assert.equal((await get(srv.base, '/api/login', {}, 'POST')).status, 503, 'fail-closed refuses during outage');

    redisProc = launchRedis(launcher, port);
    cleanups.push(async () => redisProc.stop());
    const recovered = await waitFor(async () => (await get(srv.base, '/api/login', {}, 'POST')).status === 200, 30_000);
    assert.ok(recovered, 'limiter recovers after Redis comes back');
    const r = await get(srv.base, '/api/public', { 'x-api-key': 'chaos-3' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-ratelimit-status'), null, 'real limiting resumes (no bypass header)');
  },
);

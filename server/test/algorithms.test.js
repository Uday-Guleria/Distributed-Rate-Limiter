import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis, waitReady } from '../src/redis.js';
import { runAlgorithm } from '../src/limiter/algorithms.js';
import { REDIS_URL, uid, sleep } from './helpers.js';

const redis = createRedis(REDIS_URL);
await waitReady(redis);
after(() => redis.disconnect());

const count = (results) => results.filter((r) => r.allowed).length;

test('fixed window: 500 concurrent requests -> exactly `limit` allowed', async () => {
  const p = { route: uid('fw'), identity: 'ip:1', limit: 50, windowMs: 5000 };
  const results = await Promise.all(Array.from({ length: 500 }, () => runAlgorithm(redis, 'fixed-window', p)));
  assert.equal(count(results), 50);
});

test('fixed window: counter resets after the window and the key expires', async () => {
  const p = { route: uid('fw'), identity: 'ip:1', limit: 2, windowMs: 300 };
  assert.equal((await runAlgorithm(redis, 'fixed-window', p)).allowed, true);
  assert.equal((await runAlgorithm(redis, 'fixed-window', p)).allowed, true);
  const denied = await runAlgorithm(redis, 'fixed-window', p);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 300);
  await sleep(350);
  assert.equal((await runAlgorithm(redis, 'fixed-window', p)).allowed, true);
});

test('sliding window: 500 concurrent requests -> exactly `limit` allowed (no overcounting)', async () => {
  const p = { route: uid('sw'), identity: 'ip:1', limit: 40, windowMs: 5000 };
  const results = await Promise.all(Array.from({ length: 500 }, () => runAlgorithm(redis, 'sliding-window', p)));
  assert.equal(count(results), 40);
});

test('sliding window: old requests age out one at a time', async () => {
  const p = { route: uid('sw'), identity: 'ip:1', limit: 3, windowMs: 400 };
  for (let i = 0; i < 3; i++) assert.equal((await runAlgorithm(redis, 'sliding-window', p)).allowed, true);
  const denied = await runAlgorithm(redis, 'sliding-window', p);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);
  await sleep(450);
  assert.equal((await runAlgorithm(redis, 'sliding-window', p)).allowed, true);
});

test('token bucket: burst up to capacity, then deny', async () => {
  const p = { route: uid('tb'), identity: 'ip:1', bucketSize: 10, refillRatePerSec: 0.5 };
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await runAlgorithm(redis, 'token-bucket', p));
  assert.equal(count(results), 10);
  assert.ok(results[10].retryAfterMs > 0);
});

test('token bucket: atomic under 100 concurrent requests', async () => {
  const p = { route: uid('tb'), identity: 'ip:1', bucketSize: 10, refillRatePerSec: 0.01 };
  const results = await Promise.all(Array.from({ length: 100 }, () => runAlgorithm(redis, 'token-bucket', p)));
  assert.equal(count(results), 10);
});

test('token bucket: refills continuously, not in a window reset', async () => {
  const p = { route: uid('tb'), identity: 'ip:1', bucketSize: 4, refillRatePerSec: 10 };
  for (let i = 0; i < 4; i++) await runAlgorithm(redis, 'token-bucket', p);
  assert.equal((await runAlgorithm(redis, 'token-bucket', p)).allowed, false);
  await sleep(250); // ~2.5 tokens
  const a = await runAlgorithm(redis, 'token-bucket', p);
  const b = await runAlgorithm(redis, 'token-bucket', p);
  const c = await runAlgorithm(redis, 'token-bucket', p);
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, false); // partial refill, not a full reset
});

test('token bucket: cost > 1 consumes multiple tokens', async () => {
  const p = { route: uid('tb'), identity: 'ip:1', bucketSize: 10, refillRatePerSec: 0.01, cost: 4 };
  const r = [];
  for (let i = 0; i < 3; i++) r.push(await runAlgorithm(redis, 'token-bucket', p));
  assert.deepEqual(r.map((x) => x.allowed), [true, true, false]);
});

test('identities are isolated from each other', async () => {
  const route = uid('iso');
  const a = { route, identity: 'user:a', limit: 1, windowMs: 5000 };
  const b = { route, identity: 'user:b', limit: 1, windowMs: 5000 };
  assert.equal((await runAlgorithm(redis, 'fixed-window', a)).allowed, true);
  assert.equal((await runAlgorithm(redis, 'fixed-window', a)).allowed, false);
  assert.equal((await runAlgorithm(redis, 'fixed-window', b)).allowed, true);
});

test('unknown algorithm throws', async () => {
  await assert.rejects(() => runAlgorithm(redis, 'nope', { route: 'x', identity: 'y' }), /Unknown algorithm/);
});

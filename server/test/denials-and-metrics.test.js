import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DenialBatcher, createDenialQueue, startDenialWorker } from '../src/queue/denialQueue.js';
import { Metrics } from '../src/metrics.js';
import { createRedis } from '../src/redis.js';
import { startApp, get, adminToken, uid, sleep, idFor, REDIS_URL } from './helpers.js';

const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

const total = (sunk, identity) => sunk.filter((g) => g.identity === identity).reduce((a, g) => a + g.count, 0);
async function waitUntil(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}

test('DenialBatcher groups by route+identity+minute and persists once', async () => {
  const batches = [];
  const b = new DenialBatcher({ sink: async (x) => batches.push(x), flushIntervalMs: 60_000 });
  const t = Date.UTC(2026, 0, 1, 12, 0, 10);
  const waiting = [];
  for (let i = 0; i < 5; i++) waiting.push(b.add({ route: 'a', identity: 'ip:1', at: t + i * 1000 }));
  waiting.push(b.add({ route: 'a', identity: 'ip:2', at: t }));
  waiting.push(b.add({ route: 'a', identity: 'ip:1', at: t + 70_000 })); // next minute
  assert.equal(await b.flush(), 7);
  await Promise.all(waiting); // every event's promise resolves once its batch is persisted
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.equal(batches[0].find((g) => g.identity === 'ip:1' && g.minute === Math.floor(t / 60000) * 60000).count, 5);
  assert.equal(await b.flush(), 0);
  await b.close();
});

test('DenialBatcher: an event is not acknowledged until its batch is persisted', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const b = new DenialBatcher({ sink: () => gate, flushIntervalMs: 60_000 });
  let acked = false;
  const p = b.add({ route: 'a', identity: 'x', at: 1000 }).then(() => { acked = true; });
  b.flush();
  await sleep(100);
  assert.equal(acked, false, 'must still be pending while the sink is writing');
  release();
  await p;
  assert.equal(acked, true);
  await b.close();
});

test('DenialBatcher: a failing sink rejects the events so the queue can retry them', async () => {
  const b = new DenialBatcher({ sink: async () => { throw new Error('mongo down'); }, flushIntervalMs: 60_000, logger: { warn() {} } });
  const p1 = b.add({ route: 'a', identity: 'x', at: 1000 });
  const p2 = b.add({ route: 'a', identity: 'x', at: 2000 });
  assert.equal(await b.flush(), 0);
  await assert.rejects(p1, /mongo down/);
  await assert.rejects(p2, /mongo down/);
  await b.close();
});

test('BullMQ end to end: denied HTTP requests reach the sink, grouped, with hashed identities', async () => {
  const redis = createRedis(REDIS_URL);
  const metrics = new Metrics(redis, uid('m'));
  const queueName = uid('q');
  const denialQueue = createDenialQueue({ redisUrl: REDIS_URL, queueName });
  const sunk = [];
  const worker = startDenialWorker({ redisUrl: REDIS_URL, queueName, sink: async (b) => sunk.push(...b), flushIntervalMs: 200 });
  const srv = await startApp({ redis, metrics, denialQueue });
  cleanups.push(async () => { await srv.close(); await worker.close(); await denialQueue.close(); redis.disconnect(); });

  const key = uid('key');
  for (let i = 0; i < 15; i++) await get(srv.base, '/api/public', { 'x-api-key': key }); // 5 denied

  assert.ok(await waitUntil(() => total(sunk, idFor(key)) >= 5), 'denials should reach the sink');
  assert.equal(total(sunk, idFor(key)), 5);
  assert.ok(sunk.every((g) => !JSON.stringify(g).includes(key)), 'raw API key must not appear in queued data');
});

test('durability: jobs held by a worker that crashes are redelivered, not lost', async () => {
  const queueName = uid('q');
  const queue = createDenialQueue({ redisUrl: REDIS_URL, queueName });
  const identity = 'key:crashtest';
  const now = Date.now();

  // Worker 1 takes the jobs but its sink never finishes, so it never acknowledges them. Then it "crashes".
  const w1 = startDenialWorker({
    redisUrl: REDIS_URL, queueName, sink: () => new Promise(() => {}),
    flushIntervalMs: 60_000, lockDuration: 1000, stalledInterval: 500,
  });
  for (let i = 0; i < 20; i++) queue.enqueue({ route: 'r', identity, at: now + i });
  assert.ok(await waitUntil(async () => (await queue.queue.getActiveCount()) === 20, 8000), 'worker 1 should hold all 20 jobs');
  clearInterval(w1.batcher.timer);
  await w1.worker.close(true); // force-close: no flush, no ack, like a killed process
  w1.connection.disconnect();

  // Worker 2 starts later with a working sink and must receive every event.
  const sunk = [];
  const w2 = startDenialWorker({
    redisUrl: REDIS_URL, queueName, sink: async (b) => sunk.push(...b),
    flushIntervalMs: 200, lockDuration: 1000, stalledInterval: 500,
  });
  cleanups.push(async () => { await w2.close(); await queue.close(); });
  assert.ok(await waitUntil(() => total(sunk, identity) >= 20, 20000), 'stalled jobs should be redelivered to the new worker');
  assert.equal(total(sunk, identity), 20);
});

test('durability: a failing sink does not lose events, BullMQ retries them', async () => {
  const queueName = uid('q');
  const queue = createDenialQueue({ redisUrl: REDIS_URL, queueName });
  const identity = 'key:flaky';
  let calls = 0;
  const sunk = [];
  const worker = startDenialWorker({
    redisUrl: REDIS_URL, queueName, flushIntervalMs: 100,
    sink: async (b) => { calls += 1; if (calls <= 2) throw new Error('mongo down'); sunk.push(...b); },
  });
  cleanups.push(async () => { await worker.close(); await queue.close(); });
  const origWarn = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < 3; i++) queue.enqueue({ route: 'r', identity, at: Date.now() + i });
    assert.ok(await waitUntil(() => total(sunk, identity) >= 3, 20000), 'events should arrive once the sink recovers');
    assert.equal(total(sunk, identity), 3);
    assert.ok(calls >= 3);
  } finally { console.warn = origWarn; }
});

test('metrics: counters, top-throttled (hashed identity) and admin-only endpoints', async () => {
  const redis = createRedis(REDIS_URL);
  const metrics = new Metrics(redis, uid('m'));
  const srv = await startApp({ redis, metrics });
  cleanups.push(async () => { await srv.close(); redis.disconnect(); });

  const key = uid('key');
  for (let i = 0; i < 14; i++) await get(srv.base, '/api/public', { 'x-api-key': key }); // 10 ok, 4 denied
  await sleep(200);

  assert.equal((await get(srv.base, '/metrics')).status, 401);
  const h = { authorization: `Bearer ${await adminToken(srv.base)}` };
  const sum = (await get(srv.base, '/metrics?minutes=5', h)).body;
  assert.equal(sum.allowed, 10);
  assert.equal(sum.denied, 4);
  assert.ok(Math.abs(sum.denyRate - 4 / 14) < 1e-9);

  const topRes = await get(srv.base, '/metrics/top-throttled', h);
  const top = topRes.body.top;
  assert.equal(top[0].route, 'public');
  assert.equal(top[0].identity, idFor(key));
  assert.equal(top[0].denied, 4);
  assert.ok(!JSON.stringify(topRes.body).includes(key), 'raw API key must not appear in the dashboard data');

  const series = (await get(srv.base, '/metrics/series?minutes=3', h)).body.series;
  assert.equal(series.length, 3);
});

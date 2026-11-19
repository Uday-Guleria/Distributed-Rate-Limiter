/**
 * Integration tests against a REAL MongoDB (no mocks, no in-memory fakes).
 *
 * Needs MongoDB reachable at MONGO_TEST_URI (default mongodb://127.0.0.1:27017). Each run uses a
 * throwaway database that is dropped afterwards. If MongoDB is not reachable the tests are
 * skipped with a message instead of failing, so `npm test` still works on a laptop without it.
 * CI runs a mongo service, so there they always execute.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { RateLimitRule } from '../src/models/RateLimitRule.js';
import { DeniedAggregate } from '../src/models/DeniedAggregate.js';
import { MongoRulesRepo } from '../src/config/rulesRepo.js';
import { ConfigCache } from '../src/config/configCache.js';
import { mongoSink, createDenialQueue, startDenialWorker } from '../src/queue/denialQueue.js';
import { startApp, get, adminToken, uid, sleep, idFor, REDIS_URL } from './helpers.js';

const MONGO_URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017';
const dbName = `rl_test_${uid('db').replace(/-/g, '_')}`;

let reachable = false;
try {
  await mongoose.connect(MONGO_URI, { dbName, serverSelectionTimeoutMS: 2000 });
  await Promise.all([RateLimitRule.init(), DeniedAggregate.init()]); // wait for index builds
  reachable = true;
} catch { /* skipped below */ }
const skip = reachable ? false : `MongoDB not reachable at ${MONGO_URI} (set MONGO_TEST_URI to run these)`;

const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
  if (reachable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const quiet = { warn() {} };
async function waitUntil(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}

test('rule repo: create, partial update, get, list, delete', { skip }, async () => {
  const repo = new MongoRulesRepo();
  const name = uid('rule');
  const created = await repo.upsert(name, { algorithm: 'fixed-window', limit: 5, windowMs: 1000 });
  assert.equal(created.limit, 5);
  assert.equal(created.enabled, true); // schema default

  const updated = await repo.upsert(name, { limit: 9 }); // partial update keeps the other fields
  assert.equal(updated.limit, 9);
  assert.equal(updated.windowMs, 1000);
  assert.equal(await RateLimitRule.countDocuments({ name }), 1, 'upsert must not create a duplicate');

  assert.equal((await repo.get(name)).limit, 9);
  assert.ok((await repo.list()).some((r) => r.name === name));

  assert.equal(await repo.remove(name), true);
  assert.equal(await repo.remove(name), false);
  assert.equal(await repo.get(name), null);
});

test('rule schema: enum and minimum validators run on updates, name is unique', { skip }, async () => {
  const repo = new MongoRulesRepo();
  await assert.rejects(repo.upsert(uid('rule'), { algorithm: 'bogus' }), /valid enum|Validation/i);
  await assert.rejects(repo.upsert(uid('rule'), { limit: 0 }), /minimum|Validation/i);

  const name = uid('rule');
  await RateLimitRule.create({ name });
  await assert.rejects(RateLimitRule.create({ name }), /E11000|duplicate/i);
});

test('indexes: denial aggregates have a unique key and a 14-day TTL', { skip }, async () => {
  const idx = await DeniedAggregate.collection.indexes();
  const unique = idx.find((i) => i.unique && i.key.route === 1 && i.key.identity === 1 && i.key.minute === 1);
  assert.ok(unique, 'unique (route, identity, minute) index');
  const ttl = idx.find((i) => i.key.minute === 1 && i.expireAfterSeconds !== undefined);
  assert.equal(ttl.expireAfterSeconds, 60 * 60 * 24 * 14);
});

test('denial aggregation: counts add up, firstAt takes the minimum, lastAt the maximum', { skip }, async () => {
  const route = uid('route'), identity = 'ip:agg';
  const minute = Math.floor(Date.now() / 60000) * 60000;
  await mongoSink([{ route, identity, minute, count: 3, firstAt: minute + 1000, lastAt: minute + 3000 }]);
  await mongoSink([{ route, identity, minute, count: 2, firstAt: minute + 500, lastAt: minute + 2000 }]);
  await mongoSink([{ route, identity, minute: minute + 60000, count: 7, firstAt: minute + 61000, lastAt: minute + 62000 }]);

  const docs = await DeniedAggregate.find({ route, identity }).sort({ minute: 1 }).lean();
  assert.equal(docs.length, 2, 'one document per minute');
  assert.equal(docs[0].count, 5);
  assert.equal(docs[0].firstAt.getTime(), minute + 500);
  assert.equal(docs[0].lastAt.getTime(), minute + 3000);
  assert.equal(docs[1].count, 7);
});

test('denial aggregation is safe under concurrent writers (several workers flushing at once)', { skip }, async () => {
  const route = uid('route'), identity = 'ip:concurrent';
  const minute = Math.floor(Date.now() / 60000) * 60000;
  const g = { route, identity, minute, count: 1, firstAt: minute, lastAt: minute };
  await Promise.all(Array.from({ length: 40 }, () => mongoSink([g])));
  const docs = await DeniedAggregate.find({ route, identity }).lean();
  assert.equal(docs.length, 1, 'no duplicate rows from racing upserts');
  assert.equal(docs[0].count, 40, 'no lost increments');
});

test('rules persist: a fresh cache (simulating a restart) loads them from MongoDB', { skip }, async () => {
  const repo = new MongoRulesRepo();
  const name = uid('rule');
  await repo.upsert(name, { limit: 42 });
  const cache = await new ConfigCache({ repo, logger: quiet }).start();
  cleanups.push(() => cache.stop());
  assert.equal(cache.get(name).limit, 42);
  await repo.remove(name);
  await cache.refresh();
  assert.equal(cache.get(name), undefined);
});

test('admin API on MongoDB: override persists, invalid change is not stored, delete restores defaults', { skip }, async () => {
  const repo = new MongoRulesRepo();
  const configCache = await new ConfigCache({ repo, logger: quiet }).start();
  const srv = await startApp({ repo, configCache });
  cleanups.push(async () => { await srv.close(); await configCache.stop(); });
  const admin = { authorization: `Bearer ${await adminToken(srv.base)}`, 'content-type': 'application/json' };
  const put = (body) => fetch(`${srv.base}/admin/rules/public`, { method: 'PUT', headers: admin, body: JSON.stringify(body) });
  const hits = async (n) => {
    const key = uid('key'); const out = [];
    for (let i = 0; i < n; i++) out.push((await get(srv.base, '/api/public', { 'x-api-key': key })).status);
    return out;
  };

  assert.equal((await put({ limit: 3 })).status, 200);
  assert.equal((await RateLimitRule.findOne({ name: 'public' }).lean()).limit, 3); // really in MongoDB
  assert.deepEqual(await hits(5), [200, 200, 200, 429, 429]);

  const bad = await put({ algorithm: 'token-bucket' }); // missing bucketSize / refillRatePerSec
  assert.equal(bad.status, 400);
  assert.equal((await RateLimitRule.findOne({ name: 'public' }).lean()).algorithm, undefined, 'invalid change must not reach the database');

  const del = await fetch(`${srv.base}/admin/rules/public`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200);
  assert.equal(await RateLimitRule.countDocuments({ name: 'public' }), 0);
  assert.equal((await hits(12)).filter((c) => c === 200).length, 10); // back to the built-in limit
});

test('end to end: denied HTTP requests -> BullMQ -> worker -> MongoDB aggregate rows', { skip }, async () => {
  const queueName = uid('q');
  const denialQueue = createDenialQueue({ redisUrl: REDIS_URL, queueName });
  const worker = startDenialWorker({ redisUrl: REDIS_URL, queueName, sink: mongoSink, flushIntervalMs: 200 });
  const srv = await startApp({ denialQueue });
  cleanups.push(async () => { await srv.close(); await worker.close(); await denialQueue.close(); });

  const key = uid('key');
  for (let i = 0; i < 16; i++) await get(srv.base, '/api/public', { 'x-api-key': key }); // 6 denied
  const identity = idFor(key);
  const sum = async () => (await DeniedAggregate.find({ identity, route: 'public' }).lean()).reduce((a, d) => a + d.count, 0);
  assert.ok(await waitUntil(async () => (await sum()) >= 6), 'denials should be written to MongoDB');
  assert.equal(await sum(), 6);
  const raw = await DeniedAggregate.find({ route: 'public' }).lean();
  assert.ok(raw.every((d) => !JSON.stringify(d).includes(key)), 'raw API key must not be stored in MongoDB');
});

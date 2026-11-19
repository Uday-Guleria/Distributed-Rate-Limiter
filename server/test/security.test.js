import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis } from '../src/redis.js';
import { Metrics } from '../src/metrics.js';
import { parseTrustProxy } from '../src/config/trustProxy.js';
import { hashApiKey, deriveIdentitySecret } from '../src/limiter/identity.js';
import { startApp, get, adminToken, uid, sleep, idFor, REDIS_URL } from './helpers.js';

const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

// ---------- API keys are hashed ----------
test('hashing: stable, keyed, and different keys / secrets give different identities', () => {
  const s1 = deriveIdentitySecret('secret-1');
  const s2 = deriveIdentitySecret('secret-2');
  assert.equal(hashApiKey('abc', s1), hashApiKey('abc', s1));
  assert.notEqual(hashApiKey('abc', s1), hashApiKey('abd', s1));
  assert.notEqual(hashApiKey('abc', s1), hashApiKey('abc', s2));
  assert.match(hashApiKey('abc', s1), /^[0-9a-f]{16}$/);
});

test('API keys never reach Redis keys, metrics or the dashboard endpoints', async () => {
  const redis = createRedis(REDIS_URL);
  const prefix = uid('m');
  const metrics = new Metrics(redis, prefix);
  const srv = await startApp({ redis, metrics });
  cleanups.push(async () => { await srv.close(); redis.disconnect(); });

  const secretKey = `sk_live_${uid('verysecret')}`;
  for (let i = 0; i < 12; i++) await get(srv.base, '/api/public', { 'x-api-key': secretKey }); // some denied
  await sleep(200);

  // Raw key appears in no Redis key name...
  assert.deepEqual(await redis.keys(`*${secretKey}*`), []);
  // ...but the hashed identity does (so limiting is really keyed on it).
  assert.ok((await redis.keys(`rl:fw:public:${idFor(secretKey)}`)).length === 1);
  // ...and not in any stored metrics member.
  const members = await redis.zrange(`${prefix}:throttled`, 0, -1);
  assert.ok(members.length > 0);
  assert.ok(members.every((m) => !m.includes(secretKey)));
  // ...nor in what the dashboard endpoint returns.
  const h = { authorization: `Bearer ${await adminToken(srv.base)}` };
  const top = await get(srv.base, '/metrics/top-throttled', h);
  assert.ok(!JSON.stringify(top.body).includes(secretKey));
  assert.equal(top.body.top[0].identity, idFor(secretKey));
});

test('same API key hits the same budget on two app instances sharing a secret', async () => {
  const redis = createRedis(REDIS_URL);
  const a = await startApp({ redis, identitySecret: 'shared' });
  const b = await startApp({ redis, identitySecret: 'shared' });
  cleanups.push(async () => { await a.close(); await b.close(); redis.disconnect(); });
  const key = uid('key');
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await get(i % 2 ? a.base : b.base, '/api/public', { 'x-api-key': key })).status);
  assert.equal(codes.filter((c) => c === 200).length, 10);
  assert.equal(codes.filter((c) => c === 429).length, 2);
});

// ---------- trust proxy ----------
test('parseTrustProxy: safe defaults and explicit values only', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.deepEqual(parseTrustProxy('10.0.0.0/8, 192.168.1.5'), ['10.0.0.0/8', '192.168.1.5']);
  assert.throws(() => parseTrustProxy('true'), /spoof/);
  assert.throws(() => parseTrustProxy('not-an-address!!'), /Invalid TRUST_PROXY/);
});

const fakeIp = () => `203.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

test('trust proxy ON for the proxy address: each forwarded client IP gets its own budget', async () => {
  const srv = await startApp({ trustProxy: 'loopback' });
  cleanups.push(() => srv.close());
  const a = fakeIp(), b = fakeIp();
  const codesA = [];
  for (let i = 0; i < 11; i++) codesA.push((await get(srv.base, '/api/public', { 'x-forwarded-for': a })).status);
  assert.equal(codesA.filter((c) => c === 200).length, 10);
  assert.equal(codesA[10], 429);
  assert.equal((await get(srv.base, '/api/public', { 'x-forwarded-for': b })).status, 200); // other client unaffected
});

test('trust proxy OFF (default): a spoofed X-Forwarded-For cannot dodge the limit', async () => {
  const srv = await startApp({});
  cleanups.push(() => srv.close());
  const warn = console.warn; console.warn = () => {};
  try {
    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await get(srv.base, '/api/public', { 'x-forwarded-for': fakeIp() })).status);
    assert.ok(codes.filter((c) => c === 200).length <= 10, 'forged IPs must not each get a fresh budget');
    assert.ok(codes.includes(429));
  } finally { console.warn = warn; }
});

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, get, adminToken, uid, SECRET } from './helpers.js';
import { createAuth } from '../src/auth/auth.js';

let srv;
before(async () => { srv = await startApp(); });
after(() => srv.close());

test('429 after the limit with rate-limit headers and Retry-After', async () => {
  const key = uid('key');
  const statuses = [];
  let last;
  for (let i = 0; i < 12; i++) { last = await get(srv.base, '/api/public', { 'x-api-key': key }); statuses.push(last.status); }
  assert.equal(statuses.filter((s) => s === 200).length, 10);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
  assert.equal(last.headers.get('x-ratelimit-limit'), '10');
  assert.equal(last.headers.get('x-ratelimit-remaining'), '0');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
  assert.equal(last.body.error, 'too_many_requests');
});

test('remaining header counts down on allowed requests', async () => {
  const key = uid('key');
  const a = await get(srv.base, '/api/public', { 'x-api-key': key });
  const b = await get(srv.base, '/api/public', { 'x-api-key': key });
  assert.equal(a.headers.get('x-ratelimit-remaining'), '9');
  assert.equal(b.headers.get('x-ratelimit-remaining'), '8');
});

test('different API keys have independent budgets', async () => {
  const a = uid('key'), b = uid('key');
  for (let i = 0; i < 10; i++) await get(srv.base, '/api/public', { 'x-api-key': a });
  assert.equal((await get(srv.base, '/api/public', { 'x-api-key': a })).status, 429);
  assert.equal((await get(srv.base, '/api/public', { 'x-api-key': b })).status, 200);
});

test('auth: 401 with no token, 401 with bad token, 200 with valid token', async () => {
  assert.equal((await get(srv.base, '/api/account')).status, 401);
  assert.equal((await get(srv.base, '/api/account', { authorization: 'Bearer garbage' })).status, 401);
  const token = createAuth({ secret: SECRET }).sign({ sub: uid('u'), role: 'user' });
  assert.equal((await get(srv.base, '/api/account', { authorization: `Bearer ${token}` })).status, 200);
});

test('auth: limit is per verified user (sub), not per IP', async () => {
  const auth = createAuth({ secret: SECRET });
  const tA = auth.sign({ sub: uid('alice') }), tB = auth.sign({ sub: uid('bob') });
  const out = [];
  for (let i = 0; i < 25; i++) out.push((await get(srv.base, '/api/account', { authorization: `Bearer ${tA}` })).status);
  assert.equal(out.filter((s) => s === 200).length, 20);
  assert.equal((await get(srv.base, '/api/account', { authorization: `Bearer ${tB}` })).status, 200); // same IP, different user
});

test('sliding-window and token-bucket routes enforce through HTTP', async () => {
  const key = uid('key');
  const spike = [];
  for (let i = 0; i < 12; i++) spike.push((await get(srv.base, '/api/spike', { 'x-api-key': key })).status);
  assert.equal(spike.filter((s) => s === 200).length, 10);
  const key2 = uid('key');
  const search = [];
  for (let i = 0; i < 22; i++) search.push((await get(srv.base, '/api/search', { 'x-api-key': key2 })).status);
  assert.equal(search.filter((s) => s === 200).length, 20);
});

test('dev token endpoint can issue an admin token', async () => {
  const t = await adminToken(srv.base);
  assert.ok(t.split('.').length === 3);
});

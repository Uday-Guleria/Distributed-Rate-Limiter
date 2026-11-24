import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseCorsOrigins } from '../src/cors.js';
import { startApp } from './helpers.js';

const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

const DASH = 'https://my-dashboard.onrender.com';

test('parseCorsOrigins: exact origins only, normalised, wildcard and junk refused', () => {
  assert.deepEqual(parseCorsOrigins(undefined), []);
  assert.deepEqual(parseCorsOrigins(''), []);
  assert.deepEqual(parseCorsOrigins(`${DASH}/`), [DASH]); // trailing slash removed
  assert.deepEqual(parseCorsOrigins(`${DASH}, http://localhost:5173`), [DASH, 'http://localhost:5173']);
  assert.throws(() => parseCorsOrigins('*'), /wildcard/);
  assert.throws(() => parseCorsOrigins('https://*.onrender.com'), /wildcard/);
  assert.throws(() => parseCorsOrigins('my-dashboard'), /not a URL/);
});

test('an allowed origin gets CORS headers and can read the rate-limit headers', async () => {
  const srv = await startApp({ corsOrigins: [DASH] });
  cleanups.push(() => srv.close());
  const res = await fetch(`${srv.base}/health`, { headers: { origin: DASH } });
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);
  assert.match(res.headers.get('vary') || '', /Origin/i);
  assert.match(res.headers.get('access-control-expose-headers') || '', /Retry-After/);
});

test('another origin gets no CORS headers, so the browser blocks it', async () => {
  const srv = await startApp({ corsOrigins: [DASH] });
  cleanups.push(() => srv.close());
  const res = await fetch(`${srv.base}/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('without CORS_ORIGIN nothing is added (same-origin only)', async () => {
  const srv = await startApp({});
  cleanups.push(() => srv.close());
  const res = await fetch(`${srv.base}/health`, { headers: { origin: DASH } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('preflight from the dashboard is answered with 204, allows the Authorization header, and skips auth', async () => {
  const srv = await startApp({ corsOrigins: [DASH] });
  cleanups.push(() => srv.close());
  const res = await fetch(`${srv.base}/admin/rules/public`, {
    method: 'OPTIONS',
    headers: {
      origin: DASH,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(res.status, 204); // not 401: the browser sends no token on a preflight
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);
  assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/i);
  assert.match(res.headers.get('access-control-allow-methods') || '', /PUT/);
});

test('the root URL answers with a small status document instead of "Cannot GET /"', async () => {
  const srv = await startApp({});
  cleanups.push(() => srv.close());
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp } from '../src/limiter/identity.js';
import { startApp, get, adminToken } from './helpers.js';

const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

const fakeIp = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const reqWith = (headers, ip = '10.0.0.1') => ({ ip, get: (n) => headers[n.toLowerCase()] });

test('getClientIp: ignores the header unless a header name is configured', () => {
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': '203.0.113.9' }), null), '10.0.0.1');
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': '203.0.113.9' }), undefined), '10.0.0.1');
});

test('getClientIp: uses the configured header when it holds a real IP (first value of a list)', () => {
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': '203.0.113.9' }), 'cf-connecting-ip'), '203.0.113.9');
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': '203.0.113.9, 10.1.1.1' }), 'cf-connecting-ip'), '203.0.113.9');
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': '2001:db8::1' }), 'cf-connecting-ip'), '2001:db8::1');
});

test('getClientIp: junk or a missing header falls back to req.ip', () => {
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': 'not-an-ip' }), 'cf-connecting-ip'), '10.0.0.1');
  assert.equal(getClientIp(reqWith({ 'cf-connecting-ip': "1.2.3.4'; DROP" }), 'cf-connecting-ip'), '10.0.0.1');
  assert.equal(getClientIp(reqWith({}), 'cf-connecting-ip'), '10.0.0.1');
});

test('with CLIENT_IP_HEADER set, each address behind the proxy gets its own budget and repeats share one', async () => {
  const srv = await startApp({ clientIpHeader: 'cf-connecting-ip' });
  cleanups.push(() => srv.close());
  const a = fakeIp(), b = fakeIp();
  const codesA = [];
  for (let i = 0; i < 11; i++) codesA.push((await get(srv.base, '/api/public', { 'cf-connecting-ip': a })).status);
  assert.equal(codesA.filter((c) => c === 200).length, 10);
  assert.equal(codesA[10], 429);
  assert.equal((await get(srv.base, '/api/public', { 'cf-connecting-ip': b })).status, 200);
});

test('without CLIENT_IP_HEADER the header is ignored, so forging it does not dodge the limit', async () => {
  const srv = await startApp({});
  cleanups.push(() => srv.close());
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await get(srv.base, '/api/public', { 'cf-connecting-ip': fakeIp() })).status);
  assert.ok(codes.filter((c) => c === 200).length <= 10);
  assert.ok(codes.includes(429));
});

test('/admin/whoami is admin only and reports what the limiter would use', async () => {
  const srv = await startApp({ clientIpHeader: 'cf-connecting-ip', trustProxy: 'loopback' });
  cleanups.push(() => srv.close());
  assert.equal((await get(srv.base, '/admin/whoami')).status, 401);
  const h = { authorization: `Bearer ${await adminToken(srv.base)}`, 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '203.0.113.5' };
  const res = await get(srv.base, '/admin/whoami', h);
  assert.equal(res.status, 200);
  assert.equal(res.body.limiterWouldUse, '203.0.113.77');
  assert.equal(res.body.clientIpHeader, 'cf-connecting-ip');
  assert.equal(res.body.headers['x-forwarded-for'], '203.0.113.5');
  assert.equal(res.body.headers['cf-connecting-ip'], '203.0.113.77');
  assert.ok('socketAddress' in res.body && 'ips' in res.body);
});

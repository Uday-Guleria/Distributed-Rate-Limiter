/**
 * Measures the latency the limiter adds. /api/baseline has no middleware,
 * /api/benchmark runs the full limiter (Redis round trip + metrics) with a limit so high it never denies.
 * Requests alternate between the two so machine noise hits both equally.
 */
import { createRedis, waitReady } from '../src/redis.js';
import { Metrics } from '../src/metrics.js';
import { createApp } from '../src/app.js';

const N = Number(process.env.N || 1000);
const WARMUP = 100;
const redis = createRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
await waitReady(redis);
const app = createApp({ redis, metrics: new Metrics(redis, 'bench'), jwtSecret: 'bench' });
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const timeOne = async (path) => {
  const t = process.hrtime.bigint();
  const res = await fetch(base + path);
  await res.arrayBuffer();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

const baseline = [], limited = [];
for (let i = 0; i < N + WARMUP; i++) {
  const a = await timeOne('/api/baseline');
  const b = await timeOne('/api/benchmark');
  if (i >= WARMUP) { baseline.push(a); limited.push(b); }
}
const pct = (arr, p) => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const row = (label, arr) => console.log(`${label.padEnd(10)} p50 ${pct(arr, 50).toFixed(2)}ms   p95 ${pct(arr, 95).toFixed(2)}ms   p99 ${pct(arr, 99).toFixed(2)}ms`);
console.log(`${N} requests per route, alternating, sequential\n`);
row('baseline', baseline);
row('limited', limited);
console.log(`\nadded latency   p50 ${(pct(limited, 50) - pct(baseline, 50)).toFixed(2)}ms   p95 ${(pct(limited, 95) - pct(baseline, 95)).toFixed(2)}ms   p99 ${(pct(limited, 99) - pct(baseline, 99)).toFixed(2)}ms`);
server.close();
redis.disconnect();

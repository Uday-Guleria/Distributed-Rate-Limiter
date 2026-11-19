/**
 * Demonstrates the fixed-window boundary problem, and that the sliding window fixes it.
 * Same schedule for both algorithms: a burst just before a window boundary, then another
 * burst just after it. Prints how many requests each algorithm let through in that span.
 */
import { createRedis, waitReady } from '../src/redis.js';
import { runAlgorithm } from '../src/limiter/algorithms.js';

const LIMIT = 10;
const WINDOW = 1000;
const redis = createRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
await waitReady(redis);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const burst = (algo, p, n) => Promise.all(Array.from({ length: n }, () => runAlgorithm(redis, algo, p)));

async function trial(algo) {
  const p = { route: `demo-${algo}-${Date.now()}`, identity: 'ip:demo', limit: LIMIT, windowMs: WINDOW };
  await runAlgorithm(redis, algo, p);              // opens the window
  await sleep(WINDOW - 80);                         // wait until the window is about to end
  const start = Date.now();
  const a = await burst(algo, p, LIMIT);            // burst just before the boundary
  await sleep(110);                                 // cross the boundary
  const b = await burst(algo, p, LIMIT);            // burst just after it
  const span = Date.now() - start;
  const allowed = [...a, ...b].filter((r) => r.allowed).length;
  return { allowed, span };
}

const fixed = await trial('fixed-window');
const sliding = await trial('sliding-window');
console.log(`Limit: ${LIMIT} requests per ${WINDOW}ms`);
console.log(`fixed-window   : ${fixed.allowed} requests allowed within ${fixed.span}ms  (limit is ${LIMIT} per ${WINDOW}ms)`);
console.log(`sliding-window : ${sliding.allowed} requests allowed within ${sliding.span}ms`);
redis.disconnect();

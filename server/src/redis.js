import Redis from 'ioredis';

/**
 * Client for the hot path. Fails fast instead of queueing commands while Redis is down,
 * so the limiter's fail-open / fail-closed decision happens in milliseconds, not minutes.
 */
export function createRedis(url, overrides = {}) {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 100, 1000),
    lazyConnect: false,
    ...overrides,
  });
  client.on('error', () => {}); // surfaced through command failures; avoid unhandled 'error' events
  return client;
}

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createQueueConnection(url) {
  const c = new Redis(url, { maxRetriesPerRequest: null });
  c.on('error', () => {});
  return c;
}

/**
 * Resolves true once the client is connected, false if it is not within timeoutMs.
 * Because the hot-path client has no offline queue, commands sent before the
 * connection is ready fail (and fail-open lets traffic through), so boot code waits here.
 */
export function waitReady(client, timeoutMs = 5000) {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { client.off('ready', onReady); resolve(false); }, timeoutMs);
    const onReady = () => { clearTimeout(t); resolve(true); };
    client.once('ready', onReady);
  });
}

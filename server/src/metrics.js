/**
 * Lightweight metrics stored in Redis so every app instance contributes to one view.
 *  - per-minute allowed/denied/bypassed counters (hash per minute, 2h TTL)
 *  - sorted set of most-throttled "route|identity" pairs
 */
export class Metrics {
  constructor(redis, prefix = 'rlm') {
    this.redis = redis;
    this.p = prefix;
  }

  minuteKey(ts = Date.now()) { return `${this.p}:min:${Math.floor(ts / 60000)}`; }

  record({ route, identity, allowed, bypassed, at }) {
    const field = bypassed ? 'bypassed' : allowed ? 'allowed' : 'denied';
    const key = this.minuteKey(at);
    const pipe = this.redis.pipeline().hincrby(key, field, 1).expire(key, 7200);
    if (!bypassed && !allowed) {
      pipe.zincrby(`${this.p}:throttled`, 1, `${route}|${identity}`).expire(`${this.p}:throttled`, 86400);
    }
    // Fire and forget: metrics must never slow down or break a request.
    pipe.exec().catch(() => {});
  }

  /** Last `minutes` minutes, oldest first. */
  async series(minutes = 30) {
    const now = Math.floor(Date.now() / 60000);
    const pipe = this.redis.pipeline();
    for (let i = minutes - 1; i >= 0; i--) pipe.hgetall(`${this.p}:min:${now - i}`);
    const rows = await pipe.exec();
    return rows.map(([, h], idx) => ({
      minute: (now - (minutes - 1 - idx)) * 60000,
      allowed: Number(h?.allowed || 0),
      denied: Number(h?.denied || 0),
      bypassed: Number(h?.bypassed || 0),
    }));
  }

  async summary(minutes = 5) {
    const s = await this.series(minutes);
    const allowed = s.reduce((a, r) => a + r.allowed, 0);
    const denied = s.reduce((a, r) => a + r.denied, 0);
    const bypassed = s.reduce((a, r) => a + r.bypassed, 0);
    const total = allowed + denied;
    return { windowMinutes: minutes, allowed, denied, bypassed, denyRate: total ? denied / total : 0 };
  }

  async topThrottled(n = 10) {
    const flat = await this.redis.zrevrange(`${this.p}:throttled`, 0, n - 1, 'WITHSCORES');
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      const [route, ...rest] = flat[i].split('|');
      out.push({ route, identity: rest.join('|'), denied: Number(flat[i + 1]) });
    }
    return out;
  }
}

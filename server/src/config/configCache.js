export const INVALIDATE_CHANNEL = 'rl:config:invalidate';

/**
 * In-memory cache of rate-limit rules so the hot path never touches Mongo.
 *  - refreshes every ttlMs (safety net)
 *  - refreshes immediately when any instance publishes on the invalidate channel
 *  - on a failed refresh it keeps serving the last good rules (stale > broken)
 */
export class ConfigCache {
  constructor({ repo, ttlMs = 30_000, subscriber = null, logger = console }) {
    this.repo = repo;
    this.ttlMs = ttlMs;
    this.subscriber = subscriber;
    this.logger = logger;
    this.rules = new Map();
    this.lastRefreshAt = 0;
    this.timer = null;
  }

  async start() {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), this.ttlMs);
    this.timer.unref?.();
    if (this.subscriber) {
      this.onMessage = (channel) => { if (channel === INVALIDATE_CHANNEL) this.refresh(); };
      await this.subscriber.subscribe(INVALIDATE_CHANNEL);
      this.subscriber.on('message', this.onMessage);
    }
    return this;
  }

  get(name) { return this.rules.get(name); }
  all() { return [...this.rules.values()]; }

  async refresh() {
    try {
      const list = await this.repo.list();
      this.rules = new Map(list.map((r) => [r.name, r]));
      this.lastRefreshAt = Date.now();
      return true;
    } catch (err) {
      this.logger.warn?.(`[config] refresh failed, serving stale rules: ${err.message}`);
      return false;
    }
  }

  async stop() {
    clearInterval(this.timer);
    if (this.subscriber) {
      this.subscriber.off('message', this.onMessage);
      await this.subscriber.unsubscribe(INVALIDATE_CHANNEL).catch(() => {});
    }
  }
}

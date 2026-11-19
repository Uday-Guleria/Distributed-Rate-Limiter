import { runAlgorithm } from './algorithms.js';
import { mergeConfig, validateConfig } from './config.js';
import { resolveIdentity } from './identity.js';

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rate limiter timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });

/**
 * Factory. Returns `limit(options)` which produces Express middleware.
 * `limit.registry` maps every route name to its code-defined defaults (the admin API uses it
 * to validate overrides against the route they apply to).
 *
 * options: {
 *   name            route/rule name (also the key for dynamic config overrides)
 *   algorithm       'fixed-window' | 'sliding-window' | 'token-bucket'
 *   limit, windowMs                      (fixed + sliding)
 *   bucketSize, refillRatePerSec, cost   (token bucket)
 *   keyBy           'auto' | 'ip' | 'user' | 'apiKey' | (req) => string
 *   failOpen        true (default): allow traffic if Redis is unavailable
 *                   false: reject with 503 instead
 * }
 */
export function createRateLimiter({ redis, configCache, onDecision, identitySecret, commandTimeoutMs = 250, logger = console }) {
  const registry = new Map();
  const warned = new Set();

  function limit(options) {
    if (!options?.name) throw new Error('rateLimiter: options.name is required');
    const defaultErrors = validateConfig(mergeConfig(options, null));
    if (defaultErrors.length) throw new Error(`rateLimiter: invalid defaults for "${options.name}": ${defaultErrors.join('; ')}`);
    registry.set(options.name, options);

    return async function rateLimitMiddleware(req, res, next) {
      // Dynamic rules (Mongo -> ConfigCache) override the code defaults.
      const rule = configCache?.get(options.name);
      if (rule && rule.enabled === false) return next();

      let cfg = mergeConfig(options, rule);
      const problems = validateConfig(cfg);
      if (problems.length) {
        // A bad rule (for example written straight into the database, bypassing the admin API)
        // must never break the route. Fall back to the code defaults and say so, once.
        const k = `${options.name}:${problems.join('|')}`;
        if (!warned.has(k)) {
          warned.add(k);
          logger.warn?.(`[limiter] ignoring invalid override for "${options.name}" (${problems.join('; ')}); using defaults`);
        }
        cfg = mergeConfig(options, null);
      }

      const identity = resolveIdentity(req, cfg.keyBy, identitySecret);
      const base = { route: cfg.name, identity, algorithm: cfg.algorithm, at: Date.now() };

      let result;
      try {
        result = await withTimeout(
          runAlgorithm(redis, cfg.algorithm, { ...cfg, route: cfg.name, identity }),
          commandTimeoutMs,
        );
      } catch (err) {
        // Redis down / slow. Decision is per-route: availability vs. strictness.
        onDecision?.({ ...base, allowed: cfg.failOpen, bypassed: true, error: err.message });
        if (cfg.failOpen) {
          res.set('X-RateLimit-Status', 'bypassed');
          return next();
        }
        res.set('Retry-After', '1');
        return res.status(503).json({ error: 'rate_limiter_unavailable', message: 'Try again shortly.' });
      }

      res.set({
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.resetMs / 1000)),
      });
      onDecision?.({ ...base, allowed: result.allowed, bypassed: false });

      if (!result.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        return res.status(429).json({
          error: 'too_many_requests',
          message: 'Rate limit exceeded.',
          retryAfterMs: result.retryAfterMs,
        });
      }
      next();
    };
  }

  limit.registry = registry;
  return limit;
}

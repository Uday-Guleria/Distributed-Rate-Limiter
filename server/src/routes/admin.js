import { Router } from 'express';
import { ALGORITHMS } from '../limiter/algorithms.js';
import { mergeConfig, validateConfig } from '../limiter/config.js';
import { INVALIDATE_CHANNEL } from '../config/configCache.js';

const NUMERIC = ['limit', 'windowMs', 'bucketSize', 'refillRatePerSec'];

/** Shape check of the request body only. Cross-field rules are checked on the merged config. */
function validateBody(body) {
  const data = {};
  if (body.algorithm !== undefined) {
    if (!ALGORITHMS.includes(body.algorithm)) return { error: `algorithm must be one of ${ALGORITHMS.join(', ')}` };
    data.algorithm = body.algorithm;
  }
  for (const f of NUMERIC) {
    if (body[f] === undefined) continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n <= 0) return { error: `${f} must be a positive number` };
    data[f] = n;
  }
  for (const f of ['failOpen', 'enabled']) {
    if (body[f] === undefined) continue;
    if (typeof body[f] !== 'boolean') return { error: `${f} must be a boolean` };
    data[f] = body[f];
  }
  if (Object.keys(data).length === 0) return { error: 'No valid fields supplied' };
  return { data };
}

export function adminRoutes({ repo, configCache, publisher, auth, registry }) {
  const r = Router();
  r.use(auth.requireAdmin);

  r.get('/rules', async (_req, res) => {
    res.json({ rules: configCache.all(), lastRefreshAt: configCache.lastRefreshAt });
  });

  r.put('/rules/:name', async (req, res, next) => {
    try {
      const name = req.params.name;
      let defaults = {};
      if (registry) {
        defaults = registry.get(name);
        if (!defaults) {
          return res.status(404).json({
            error: 'unknown_route',
            message: `No route named "${name}". Known routes: ${[...registry.keys()].join(', ')}`,
          });
        }
      }

      const { data, error } = validateBody(req.body || {});
      if (error) return res.status(400).json({ error: 'invalid_rule', message: error });

      // Validate what the limiter would actually run: route defaults + stored override + this change.
      const existing = await repo.get(name);
      const effective = mergeConfig(defaults, { ...(existing || {}), ...data });
      const problems = validateConfig(effective);
      if (problems.length) {
        return res.status(400).json({ error: 'invalid_rule', message: problems.join('; ') });
      }

      const rule = await repo.upsert(name, data);
      await configCache.refresh(); // this instance sees it immediately
      await publisher?.publish(INVALIDATE_CHANNEL, name).catch(() => {}); // every other instance refreshes too
      res.json({ rule, effective });
    } catch (e) { next(e); }
  });

  r.delete('/rules/:name', async (req, res, next) => {
    try {
      const removed = await repo.remove(req.params.name);
      await configCache.refresh();
      await publisher?.publish(INVALIDATE_CHANNEL, req.params.name).catch(() => {});
      res.status(removed ? 200 : 404).json({ removed });
    } catch (e) { next(e); }
  });

  return r;
}

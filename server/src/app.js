import express from 'express';
import { createRateLimiter } from './limiter/rateLimiter.js';
import { deriveIdentitySecret, apiKeyIdentity } from './limiter/identity.js';
import { createAuth } from './auth/auth.js';
import { corsMiddleware } from './cors.js';
import { adminRoutes } from './routes/admin.js';
import { metricsRoutes } from './routes/metrics.js';

/**
 * Builds the Express app from injected dependencies, so tests and the real server
 * share the same wiring.
 *
 * deps: { redis, configCache, repo, publisher, metrics, denialQueue, jwtSecret, env, commandTimeoutMs, corsOrigins }
 */
export function createApp(deps) {
  const { redis, configCache, repo, publisher, metrics, denialQueue, jwtSecret, env = 'development', commandTimeoutMs } = deps;
  const identitySecret = deps.identitySecret || deriveIdentitySecret(jwtSecret);
  const trustProxy = deps.trustProxy ?? false;
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(deps.corsOrigins));
  app.set('trust proxy', trustProxy);
  app.use(express.json());

  // Misconfiguration hint: a proxy is probably in front of us but we are not told to trust it,
  // so every client would appear to come from the proxy's address and share one budget.
  let warnedProxy = false;
  app.use((req, _res, next) => {
    if (!warnedProxy && !trustProxy && req.get('x-forwarded-for')) {
      warnedProxy = true;
      console.warn('[proxy] X-Forwarded-For seen but TRUST_PROXY is not set: clients behind your proxy will share one IP-based limit. Set TRUST_PROXY to your proxy hop count or addresses.');
    }
    next();
  });

  const auth = createAuth({ secret: jwtSecret });
  app.use(auth.identifyUser);

  const limit = createRateLimiter({
    redis,
    configCache,
    identitySecret,
    commandTimeoutMs,
    onDecision: (d) => {
      metrics?.record(d);
      if (!d.allowed && !d.bypassed) denialQueue?.enqueue(d);
    },
  });

  app.get('/', (_req, res) => res.json({ service: 'distributed-rate-limiter', status: 'ok', health: '/health' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Dev-only token issuance so the demo and dashboard work without a login system.
  if (env !== 'production') {
    app.get('/dev/token', (req, res) => {
      const sub = String(req.query.sub || 'demo-user');
      const role = req.query.role === 'admin' ? 'admin' : 'user';
      res.json({ token: auth.sign({ sub, role }) });
    });
    // API keys are hashed everywhere (Redis, dashboard). In dev this shows which hash is which key.
    app.get('/dev/identity', (req, res) => {
      res.json({ identity: apiKeyIdentity(String(req.query.key || ''), identitySecret) });
    });
  }

  // ---- Demo routes, one per algorithm / behaviour ----
  app.get('/api/public', limit({ name: 'public', algorithm: 'fixed-window', limit: 10, windowMs: 60_000 }),
    (_req, res) => res.json({ ok: true, route: 'public' }));

  app.get('/api/search', limit({ name: 'search', algorithm: 'sliding-window', limit: 20, windowMs: 10_000 }),
    (_req, res) => res.json({ ok: true, route: 'search' }));

  app.get('/api/spike', limit({ name: 'spike', algorithm: 'token-bucket', bucketSize: 10, refillRatePerSec: 2 }),
    (_req, res) => res.json({ ok: true, route: 'spike' }));

  // Strict route: if the limiter cannot run, refuse rather than risk brute force.
  app.post('/api/login', limit({ name: 'login', algorithm: 'fixed-window', limit: 5, windowMs: 60_000, failOpen: false, keyBy: 'ip' }),
    (_req, res) => res.json({ ok: true, route: 'login' }));

  // Per verified user (JWT sub), not per IP.
  app.get('/api/account', auth.requireAuth, limit({ name: 'account', algorithm: 'fixed-window', limit: 20, windowMs: 60_000, keyBy: 'user' }),
    (req, res) => res.json({ ok: true, user: req.user.sub }));

  // Overhead measurement pair.
  app.get('/api/baseline', (_req, res) => res.json({ ok: true }));
  app.get('/api/benchmark', limit({ name: 'benchmark', algorithm: 'fixed-window', limit: 1_000_000_000, windowMs: 60_000, keyBy: 'ip' }),
    (_req, res) => res.json({ ok: true }));

  // ---- Operations ----
  if (repo && configCache) app.use('/admin', adminRoutes({ repo, configCache, publisher, auth, registry: limit.registry }));
  if (metrics) app.use('/metrics', metricsRoutes({ metrics, auth }));

  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

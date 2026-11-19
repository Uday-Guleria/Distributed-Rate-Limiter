import { Router } from 'express';

export function metricsRoutes({ metrics, auth }) {
  const r = Router();
  r.use(auth.requireAdmin);
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));

  r.get('/', async (req, res, next) => {
    try { res.json(await metrics.summary(clamp(req.query.minutes, 1, 120, 5))); } catch (e) { next(e); }
  });
  r.get('/series', async (req, res, next) => {
    try { res.json({ series: await metrics.series(clamp(req.query.minutes, 1, 120, 30)) }); } catch (e) { next(e); }
  });
  r.get('/top-throttled', async (req, res, next) => {
    try { res.json({ top: await metrics.topThrottled(clamp(req.query.n, 1, 50, 10)) }); } catch (e) { next(e); }
  });
  return r;
}

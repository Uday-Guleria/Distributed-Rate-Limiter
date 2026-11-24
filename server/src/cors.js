/**
 * Cross-origin access for a dashboard hosted on a different address than the API
 * (for example two Render services). Browsers refuse such calls unless the API says the
 * dashboard's origin is allowed. Only exact origins are accepted, never "*".
 */
export function parseCorsOrigins(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s.includes('*')) throw new Error('CORS_ORIGIN must list exact origins (e.g. https://my-dashboard.onrender.com), not a wildcard.');
      try {
        return new URL(s).origin; // normalises trailing slashes and rejects junk
      } catch {
        throw new Error(`CORS_ORIGIN contains something that is not a URL: "${s}"`);
      }
    });
}

export function corsMiddleware(origins = []) {
  if (origins.length === 0) return (_req, _res, next) => next();
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.get('origin');
    res.vary('Origin');
    if (origin && allowed.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Status, Retry-After',
      });
      if (req.method === 'OPTIONS') {
        res.set({
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
          'Access-Control-Max-Age': '600',
        });
      }
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204); // preflight never reaches the limiter or the routes
    next();
  };
}

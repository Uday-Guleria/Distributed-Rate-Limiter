import jwt from 'jsonwebtoken';

export function createAuth({ secret }) {
  /** Soft: attach req.user if a valid Bearer token is present, never rejects. */
  function identifyUser(req, _res, next) {
    const h = req.get('authorization') || '';
    if (h.startsWith('Bearer ')) {
      try {
        req.user = jwt.verify(h.slice(7), secret);
      } catch {
        req.authError = 'invalid_token';
      }
    }
    next();
  }

  /** Hard: 401 unless a valid token was attached. */
  function requireAuth(req, res, next) {
    if (req.user) return next();
    return res.status(401).json({ error: 'unauthorized', message: req.authError ? 'Invalid or expired token.' : 'Missing bearer token.' });
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return requireAuth(req, res, next);
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Admin role required.' });
    next();
  }

  const sign = (payload, opts = { expiresIn: '1h' }) => jwt.sign(payload, secret, opts);
  return { identifyUser, requireAuth, requireAdmin, sign };
}

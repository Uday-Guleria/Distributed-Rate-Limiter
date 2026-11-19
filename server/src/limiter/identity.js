import { createHmac } from 'node:crypto';

/**
 * API keys are credentials. They must never be written to Redis keys, metrics, queues,
 * MongoDB or the dashboard. We use a keyed hash (HMAC-SHA256) rather than a bare hash so that
 * someone who can read Redis cannot brute-force common keys offline without the secret.
 * The secret must be identical on every app instance, or instances would disagree on identities.
 */
export function deriveIdentitySecret(jwtSecret) {
  return createHmac('sha256', jwtSecret).update('rate-limiter:identity:v1').digest('hex');
}

export function hashApiKey(key, secret) {
  return createHmac('sha256', secret).update(String(key)).digest('hex').slice(0, 16);
}

export const apiKeyIdentity = (key, secret) => `key:${hashApiKey(key, secret)}`;

/** Who is being limited: verified user > API key (hashed) > IP. */
export function resolveIdentity(req, keyBy = 'auto', secret) {
  if (typeof keyBy === 'function') return keyBy(req);
  const apiKey = req.get('x-api-key');
  const byKey = () => {
    if (!secret) throw new Error('identity secret is required to key limits by API key');
    return apiKeyIdentity(apiKey, secret);
  };
  if (keyBy === 'ip') return `ip:${req.ip}`;
  if (keyBy === 'user' && req.user?.sub) return `user:${req.user.sub}`;
  if (keyBy === 'apiKey' && apiKey) return byKey();
  if (keyBy === 'auto') {
    if (req.user?.sub) return `user:${req.user.sub}`;
    if (apiKey) return byKey();
  }
  return `ip:${req.ip}`;
}

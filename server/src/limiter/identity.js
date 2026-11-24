import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

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

/**
 * The client's IP address. By default that is Express's req.ip, which depends on TRUST_PROXY.
 * Some hosts (for example Render, which sits behind Cloudflare) are better served by reading the
 * address from a header the edge sets, such as cf-connecting-ip. That header is only trusted when
 * CLIENT_IP_HEADER names it, and only if its value is a real IP address; anything else falls back
 * to req.ip. Only enable it when every request reaches the app through the proxy that sets it,
 * otherwise a client could send the header itself and pick its own address.
 */
export function getClientIp(req, clientIpHeader) {
  if (clientIpHeader) {
    const raw = req.get(clientIpHeader);
    if (raw) {
      const first = raw.split(',')[0].trim();
      if (isIP(first)) return first;
    }
  }
  return req.ip;
}

/** Who is being limited: verified user > API key (hashed) > IP. */
export function resolveIdentity(req, keyBy = 'auto', secret, clientIpHeader) {
  if (typeof keyBy === 'function') return keyBy(req);
  const apiKey = req.get('x-api-key');
  const byKey = () => {
    if (!secret) throw new Error('identity secret is required to key limits by API key');
    return apiKeyIdentity(apiKey, secret);
  };
  if (keyBy === 'ip') return `ip:${getClientIp(req, clientIpHeader)}`;
  if (keyBy === 'user' && req.user?.sub) return `user:${req.user.sub}`;
  if (keyBy === 'apiKey' && apiKey) return byKey();
  if (keyBy === 'auto') {
    if (req.user?.sub) return `user:${req.user.sub}`;
    if (apiKey) return byKey();
  }
  return `ip:${getClientIp(req, clientIpHeader)}`;
}

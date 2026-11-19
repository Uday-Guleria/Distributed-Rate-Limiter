import express from 'express';

/**
 * Turns the TRUST_PROXY environment value into an Express "trust proxy" setting.
 *
 * Behind a reverse proxy / load balancer, every connection comes from the proxy, so without
 * this all clients share one IP and one rate-limit budget. But trusting X-Forwarded-For
 * blindly is worse: any client can send that header and pick a fresh "IP" per request.
 * So we only accept explicit values:
 *
 *   (unset) / false          trust nothing; use the socket address            [default]
 *   1, 2, ...                trust that many proxy hops in front of the app
 *   10.0.0.5, 10.0.1.0/24    trust exactly these proxy addresses / CIDR ranges
 *   loopback, linklocal, uniquelocal   Express keywords for private ranges
 *
 * "true" (trust everyone) is refused.
 */
export function parseTrustProxy(raw) {
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true trusts every X-Forwarded-For header, so clients could spoof their IP and dodge limits. ' +
        'Use a hop count (e.g. 1) or explicit proxy addresses (e.g. 10.0.0.0/8 or loopback).',
    );
  }
  let parsed;
  if (/^\d+$/.test(v)) {
    parsed = Number(v);
    if (parsed === 0) return false;
  } else {
    const list = v.split(',').map((s) => s.trim()).filter(Boolean);
    parsed = list.length === 1 ? list[0] : list;
  }
  try {
    express().set('trust proxy', parsed); // Express validates addresses/CIDRs when the setting is applied
  } catch (err) {
    throw new Error(`Invalid TRUST_PROXY value "${v}": ${err.message}`);
  }
  return parsed;
}

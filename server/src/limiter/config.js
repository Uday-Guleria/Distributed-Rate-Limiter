import { ALGORITHMS } from './algorithms.js';

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const positiveInt = (v) => positive(v) && Number.isInteger(v);

/**
 * Validates an EFFECTIVE configuration: the code defaults for a route merged with any
 * dynamic override. Each algorithm needs its own parameters, so "switch fixed-window to
 * token-bucket" is only valid if bucketSize and refillRatePerSec end up defined.
 * Returns a list of human-readable problems (empty = valid).
 */
export function validateConfig(cfg) {
  const errors = [];
  if (!ALGORITHMS.includes(cfg.algorithm)) {
    errors.push(`algorithm must be one of ${ALGORITHMS.join(', ')}`);
    return errors;
  }
  if (cfg.algorithm === 'token-bucket') {
    if (!positive(cfg.bucketSize)) errors.push('token-bucket requires bucketSize (a positive number)');
    if (!positive(cfg.refillRatePerSec)) errors.push('token-bucket requires refillRatePerSec (a positive number)');
    if (cfg.cost !== undefined && !positive(cfg.cost)) errors.push('cost must be a positive number');
  } else {
    if (!positiveInt(cfg.limit)) errors.push(`${cfg.algorithm} requires limit (a positive whole number)`);
    if (!positiveInt(cfg.windowMs)) errors.push(`${cfg.algorithm} requires windowMs (a positive whole number of milliseconds)`);
  }
  return errors;
}

/** Code defaults for a route + (optional) stored override -> the config the limiter will actually use. */
export function mergeConfig(defaults, rule) {
  const { name, _id, __v, createdAt, updatedAt, enabled, ...overrides } = rule || {};
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null));
  return { algorithm: 'fixed-window', failOpen: true, keyBy: 'auto', ...defaults, ...clean };
}

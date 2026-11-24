import 'dotenv/config';
import { createRedis, waitReady } from './redis.js';
import { ConfigCache } from './config/configCache.js';
import { MemoryRulesRepo, MongoRulesRepo, connectMongo } from './config/rulesRepo.js';
import { createDenialQueue, startDenialWorker, mongoSink } from './queue/denialQueue.js';
import { Metrics } from './metrics.js';
import { createApp } from './app.js';
import { parseTrustProxy } from './config/trustProxy.js';
import { parseCorsOrigins } from './cors.js';

const port = Number(process.env.PORT || 3000);
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const mongoUri = process.env.MONGO_URI;
const env = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
if (env === 'production' && jwtSecret === 'dev-secret-change-me') {
  console.error('Refusing to start in production with the default JWT_SECRET.');
  process.exit(1);
}

let trustProxy;
try {
  trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`[proxy] trust proxy = ${JSON.stringify(trustProxy)}`);

const clientIpHeader = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase() || null;
if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) {
  console.error(`CLIENT_IP_HEADER must be a header name such as cf-connecting-ip, got "${clientIpHeader}".`);
  process.exit(1);
}
console.log(`[proxy] client IP header = ${clientIpHeader ?? '(none, using req.ip)'}`);

let corsOrigins;
try {
  corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`[cors] allowed origins = ${corsOrigins.length ? corsOrigins.join(', ') : '(none, same-origin only)'}`);

// If Redis is far away (different region, or a hosted service like Upstash), 250 ms can be too tight
// and every check would time out and fall back to fail-open / fail-closed.
const commandTimeoutMs = Number(process.env.LIMITER_TIMEOUT_MS) || 250;

const redis = createRedis(redisUrl);
const subscriber = createRedis(redisUrl, { enableOfflineQueue: true, maxRetriesPerRequest: null });
const publisher = createRedis(redisUrl);
if (!(await waitReady(redis))) console.warn('[redis] not reachable at startup; limiter will follow each route\'s fail-open/closed policy until it connects');

let repo;
let sink = async (batch) => console.log(`[denials] ${batch.length} groups (no MONGO_URI, console sink)`);
if (mongoUri) {
  await connectMongo(mongoUri);
  repo = new MongoRulesRepo();
  sink = mongoSink;
  console.log('[mongo] connected');
} else {
  repo = new MemoryRulesRepo();
  console.log('[mongo] MONGO_URI not set: rules held in memory, denials logged to console');
}

const configCache = await new ConfigCache({ repo, subscriber }).start();
const metrics = new Metrics(redis);
const denialQueue = createDenialQueue({ redisUrl });
const denialWorker = startDenialWorker({ redisUrl, sink });

const app = createApp({ redis, configCache, repo, publisher, metrics, denialQueue, jwtSecret, env, trustProxy, clientIpHeader, corsOrigins, commandTimeoutMs, identitySecret: process.env.IDENTITY_SECRET || undefined });
const server = app.listen(port, () => console.log(`rate limiter API listening on :${port}`));

async function shutdown() {
  console.log('shutting down...');
  server.close();
  await configCache.stop();
  await denialWorker.close();
  await denialQueue.close();
  redis.disconnect(); subscriber.disconnect(); publisher.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

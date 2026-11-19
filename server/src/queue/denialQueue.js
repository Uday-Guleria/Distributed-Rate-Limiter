import { Queue, Worker } from 'bullmq';
import { createQueueConnection } from '../redis.js';

export const QUEUE_NAME = 'denied-requests';

/**
 * Producer side: called from the request path, never awaited (audit logging must not slow or
 * break a response). Once a job is in Redis it is durable: BullMQ keeps it until a worker
 * finishes it, and retries it with backoff if the worker fails.
 */
export function createDenialQueue({ redisUrl, queueName = QUEUE_NAME }) {
  const connection = createQueueConnection(redisUrl);
  const queue = new Queue(queueName, { connection });
  return {
    queue,
    enqueue(d) {
      queue
        .add('denied', { route: d.route, identity: d.identity, at: d.at }, {
          removeOnComplete: true,
          removeOnFail: 5000, // keep exhausted jobs so they can be inspected / replayed
          attempts: 8,
          backoff: { type: 'exponential', delay: 1000 }, // ~4 minutes of sink outage is tolerated
        })
        .catch(() => {});
    },
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}

/**
 * Collapses many denial events into one row per (route, identity, minute) before writing.
 *
 * add() returns a promise that settles only after the batch containing the event has been
 * persisted by the sink: it resolves on success and REJECTS if the sink failed. The worker
 * returns that promise from the job processor, so a job is acknowledged only after its data is
 * safely stored. If the worker dies first, the job was never acknowledged and BullMQ
 * redelivers it (at-least-once delivery).
 */
export class DenialBatcher {
  constructor({ sink, flushIntervalMs = 5000, maxBuffered = 500, logger = console }) {
    this.sink = sink;
    this.maxBuffered = maxBuffered;
    this.logger = logger;
    this.inflight = new Set();
    this.current = this.#newBatch();
    this.timer = setInterval(() => this.flush(), flushIntervalMs);
    this.timer.unref?.();
  }

  #newBatch() { return { groups: new Map(), waiters: [] }; }

  add({ route, identity, at }) {
    const batch = this.current;
    const minute = Math.floor(at / 60000) * 60000;
    const k = `${route}\u0000${identity}\u0000${minute}`;
    const g = batch.groups.get(k);
    if (g) {
      g.count += 1;
      g.firstAt = Math.min(g.firstAt, at);
      g.lastAt = Math.max(g.lastAt, at);
    } else {
      batch.groups.set(k, { route, identity, minute, count: 1, firstAt: at, lastAt: at });
    }
    const settled = new Promise((resolve, reject) => batch.waiters.push({ resolve, reject }));
    if (batch.waiters.length >= this.maxBuffered) this.flush();
    return settled;
  }

  /** Persists the current batch. Resolves with the number of events persisted (0 on failure). */
  flush() {
    const batch = this.current;
    if (batch.waiters.length === 0) return Promise.resolve(0);
    this.current = this.#newBatch();
    const run = (async () => {
      try {
        await this.sink([...batch.groups.values()]);
        batch.waiters.forEach((w) => w.resolve());
        return batch.waiters.length;
      } catch (err) {
        // Reject every job in the batch: BullMQ retries them with backoff, so nothing is dropped.
        this.logger.warn?.(`[denials] flush failed (${batch.waiters.length} events will be retried): ${err.message}`);
        batch.waiters.forEach((w) => w.reject(err));
        return 0;
      }
    })();
    this.inflight.add(run);
    run.finally(() => this.inflight.delete(run));
    return run;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
    await Promise.allSettled([...this.inflight]);
  }
}

/** Mongo sink: one upsert per group, $inc'd so multiple workers can write concurrently. */
export async function mongoSink(batch) {
  const { DeniedAggregate } = await import('../models/DeniedAggregate.js');
  await DeniedAggregate.bulkWrite(
    batch.map((g) => ({
      updateOne: {
        filter: { route: g.route, identity: g.identity, minute: new Date(g.minute) },
        update: {
          $inc: { count: g.count },
          $min: { firstAt: new Date(g.firstAt) },
          $max: { lastAt: new Date(g.lastAt) },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export function startDenialWorker({
  redisUrl,
  sink,
  queueName = QUEUE_NAME,
  flushIntervalMs = 5000,
  concurrency = 500, // jobs stay "active" until their batch is persisted, so this is also the max batch size
  lockDuration = 30_000,
  stalledInterval = 30_000,
}) {
  const connection = createQueueConnection(redisUrl);
  const batcher = new DenialBatcher({ sink, flushIntervalMs, maxBuffered: concurrency });
  const worker = new Worker(queueName, (job) => batcher.add(job.data), {
    connection,
    concurrency,
    lockDuration,
    stalledInterval,
    maxStalledCount: 5, // a crashed worker's jobs are re-queued when their lock expires
  });
  worker.on('error', () => {});
  return {
    worker,
    batcher,
    connection,
    async close() {
      await batcher.close(); // persist what we hold first, so those jobs complete instead of waiting
      await worker.close();
      connection.disconnect();
    },
  };
}

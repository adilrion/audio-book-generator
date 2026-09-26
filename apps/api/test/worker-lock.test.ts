/** WorkerLock against the real Redis (skipped when it is not running). Uses a throwaway key. */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { redisConnection } from '../src/queue/queue.service';
import { WorkerLock, type LockClient } from '../src/worker/worker-lock';

const cfg = loadConfig();
const queue = new Queue(`worker-lock-test-${randomUUID()}`, { connection: redisConnection(cfg.REDIS_URL, false) });
queue.on('error', () => undefined);
const client = async () => (await queue.client) as unknown as LockClient;
const redisUp = await Promise.race([client().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]).catch(() => false);

afterAll(async () => {
  await queue.close().catch(() => undefined);
});

describe.skipIf(!redisUp)('WorkerLock (real Redis)', () => {
  const key = `audiobook-test:worker-lock:${randomUUID()}`;

  it('lets exactly one holder in, and only the holder can release it', async () => {
    const a = new WorkerLock(client, key, 5000);
    const b = new WorkerLock(client, key, 5000);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(await b.holder()).toBe(a.token);
    await b.release(); // not the owner: no effect
    expect(await a.holder()).toBe(a.token);
    await a.release();
    expect(await a.holder()).toBeNull();
    expect(await b.tryAcquire()).toBe(true);
    await b.release();
  });

  it('renewal keeps the lock alive past its TTL and takes it back after it expired', async () => {
    const a = new WorkerLock(client, key, 1200);
    const b = new WorkerLock(client, key, 1200);
    expect(await a.tryAcquire()).toBe(true);
    a.startRenewal(() => undefined);
    await new Promise((r) => setTimeout(r, 2000));
    expect(await b.tryAcquire()).toBe(false);
    expect(await a.holder()).toBe(a.token);
    const c = await client();
    await c.eval("return redis.call('del', KEYS[1])", 1, key); // e.g. Redis restarted without persistence
    await new Promise((r) => setTimeout(r, 1300)); // next renewal tick (every max(1s, ttl/3))
    expect(await a.holder()).toBe(a.token);
    await a.release();
  });

  it('a crashed holder frees the lock after the TTL', async () => {
    const a = new WorkerLock(client, key, 300);
    const b = new WorkerLock(client, key, 300);
    expect(await a.tryAcquire()).toBe(true); // never renewed, never released
    await new Promise((r) => setTimeout(r, 450));
    expect(await b.tryAcquire()).toBe(true);
    await b.release();
  });
});

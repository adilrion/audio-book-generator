import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@app/shared';
import type { AppConfig } from '../src/common/config.provider';
import { toUserError } from '../src/common/errors';
import { QueueService, redisConnection } from '../src/queue/queue.service';

/** A localhost port nothing listens on (bind to :0, read the port, close). */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function redisReachable(port = 6379): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(500);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.once('timeout', () => (s.destroy(), resolve(false)));
  });
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);

const services: QueueService[] = [];
const make = (url: string) => {
  const s = new QueueService({ REDIS_URL: url } as AppConfig);
  services.push(s);
  return s;
};

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => within(s.onModuleDestroy(), 5000).catch(() => undefined)));
});

describe('redisConnection', () => {
  it('parses host, port, password and db', () => {
    expect(redisConnection('redis://:s3cret@redis.local:6380/2', false)).toMatchObject({ host: 'redis.local', port: 6380, password: 's3cret', db: 2 });
    expect(redisConnection('redis://localhost', false)).toMatchObject({ host: 'localhost', port: 6379, password: undefined, db: 0 });
  });

  it('fails fast for the API but blocks forever for the worker', () => {
    expect(redisConnection('redis://localhost:6379', false)).toMatchObject({ maxRetriesPerRequest: 1, enableOfflineQueue: false });
    expect(redisConnection('redis://localhost:6379', true)).toMatchObject({ maxRetriesPerRequest: null, enableOfflineQueue: true });
  });
});

describe('QueueService when Redis is not running', () => {
  it('ping() answers false quickly instead of hanging (health endpoint must respond)', async () => {
    const svc = make(`redis://127.0.0.1:${await freePort()}`);
    const t0 = Date.now();
    await expect(within(svc.ping(), 8000)).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 15_000);

  it('enqueue() rejects quickly with REDIS_UNAVAILABLE instead of hanging the HTTP request', async () => {
    const svc = make(`redis://127.0.0.1:${await freePort()}`);
    const err = await within(svc.enqueue({ projectId: 'p', renderJobId: 'rj', force: false }), 8000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('REDIS_UNAVAILABLE');
    expect((err as AppError).hint).toContain('docker compose up -d redis');
  }, 15_000);
});

describe.skipIf(!(await redisReachable()))('QueueService with the local Redis', () => {
  it('ping() answers true', async () => {
    await expect(within(make('redis://127.0.0.1:6379').ping(), 5000)).resolves.toBe(true);
  });

  it('registers the queue error listener only once, however often it is used', async () => {
    const svc = make('redis://127.0.0.1:6379');
    for (let i = 0; i < 12; i++) expect(await within(svc.ping(), 5000)).toBe(true);
    const queue = (svc as unknown as { queue: { listenerCount(e: string): number } }).queue;
    expect(queue.listenerCount('error')).toBe(1);
  });

  it('reports REDIS_UNAVAILABLE quickly when Redis goes away after connecting', async () => {
    // TCP proxy in front of the real Redis that we can "unplug" without touching Redis itself.
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const upstream = net.connect(6379, '127.0.0.1');
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on('error', () => undefined);
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const svc = make(`redis://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`);
    expect(await within(svc.ping(), 5000)).toBe(true);

    proxy.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 200));

    expect(await within(svc.ping(), 5000)).toBe(false);
    // The proxy is gone, so this can never reach the real queue.
    const err = await within(svc.enqueue({ projectId: 'p', renderJobId: `test-${Date.now()}`, force: false }), 5000).catch((e: unknown) => e);
    expect(toUserError(err).code).toBe('REDIS_UNAVAILABLE');
  }, 20_000);
});

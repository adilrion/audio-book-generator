import { randomUUID } from 'node:crypto';
import os from 'node:os';

/** The subset of an ioredis client the lock needs (BullMQ's worker connection provides it). */
export interface LockClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Extend our own lock, or take it back if it expired meanwhile; 0 = someone else holds it.
const RENEW = `local v = redis.call('get', KEYS[1])
if v == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end
if not v then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * Redis lock that lets exactly one worker process projects at a time. MAX_CONCURRENT_PROJECTS is
 * per process, so a second worker (a stray `pnpm dev:worker`, a second terminal) would otherwise
 * double the memory use, and its start-up recovery would mark the first worker's running project
 * as interrupted. A crashed holder frees the lock after `ttlMs`.
 */
export class WorkerLock {
  readonly token = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly client: () => Promise<LockClient>,
    readonly key: string,
    private readonly ttlMs = 30_000,
  ) {}

  async tryAcquire(): Promise<boolean> {
    const c = await this.client();
    return (await c.set(this.key, this.token, 'PX', this.ttlMs, 'NX')) === 'OK';
  }

  async holder(): Promise<string | null> {
    return (await this.client()).get(this.key);
  }

  /** Keep the lock alive; `onLost` fires if another process took it (only after a very long stall). */
  startRenewal(onLost: (holder: string | null) => void) {
    this.stopRenewal();
    this.timer = setInterval(() => {
      void this.client()
        .then(async (c) => {
          if (Number(await c.eval(RENEW, 1, this.key, this.token, this.ttlMs)) === 0) onLost(await c.get(this.key));
        })
        .catch(() => undefined); // Redis down: the queue reports that; retry on the next tick
    }, Math.max(1000, Math.floor(this.ttlMs / 3)));
    this.timer.unref();
  }

  stopRenewal() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async release(): Promise<void> {
    this.stopRenewal();
    await (await this.client()).eval(RELEASE, 1, this.key, this.token);
  }
}

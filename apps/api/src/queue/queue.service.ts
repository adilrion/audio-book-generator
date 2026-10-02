import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { redisUnavailable, toUserError } from '../common/errors';

export const QUEUE_NAME = 'audiobook';
/** YouTube Shorts have their own queue: a 60-second short must not wait behind a 10-hour book. */
export const SHORTS_QUEUE = 'shorts';
const READY_TIMEOUT_MS = 3000;

export interface ProcessJobData {
  projectId: string;
  renderJobId: string;
  force: boolean;
}

export interface ShortJobData {
  shortId: string;
}

export function redisConnection(url: string, forWorker: boolean) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    // Worker must block forever; API calls should fail fast when Redis is down.
    maxRetriesPerRequest: forWorker ? null : 1,
    enableOfflineQueue: forWorker,
    connectTimeout: 3000,
  };
}

/** Producer side. Video generation never runs inside an HTTP request. */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private queue?: Queue<ProcessJobData>;
  private shortsQueue?: Queue<ShortJobData>;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private get q(): Queue<ProcessJobData> {
    if (!this.queue) {
      this.queue = new Queue<ProcessJobData>(QUEUE_NAME, { connection: redisConnection(this.cfg.REDIS_URL, false) });
      this.queue.on('error', () => undefined); // surfaced via enqueue() / ping() instead
    }
    return this.queue;
  }

  private get shorts(): Queue<ShortJobData> {
    if (!this.shortsQueue) {
      this.shortsQueue = new Queue<ShortJobData>(SHORTS_QUEUE, { connection: redisConnection(this.cfg.REDIS_URL, false) });
      this.shortsQueue.on('error', () => undefined);
    }
    return this.shortsQueue;
  }

  /**
   * BullMQ waits forever for the first connection when Redis is down, which would hang the
   * HTTP request (and /system/health). Give up after a few seconds instead.
   */
  private async connected(timeoutMs = READY_TIMEOUT_MS, queue: Queue = this.q) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        queue.client,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(redisUnavailable()), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async enqueue(data: ProcessJobData): Promise<string> {
    try {
      await this.connected();
      const job = await this.q.add('process', data, {
        jobId: data.renderJobId,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      });
      return job.id!;
    } catch (e) {
      throw toUserError(e);
    }
  }

  async enqueueShort(shortId: string): Promise<string> {
    try {
      await this.connected(READY_TIMEOUT_MS, this.shorts);
      const job = await this.shorts.add('render', { shortId }, { jobId: `${shortId}-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 200 });
      return job.id!;
    } catch (e) {
      throw toUserError(e);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.connected();
      return (await (client as unknown as { ping(): Promise<string> }).ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.shortsQueue?.close().catch(() => undefined);
  }
}

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';

export const QUEUE_NAME = 'audiobook';

export interface ProcessJobData {
  projectId: string;
  renderJobId: string;
  force: boolean;
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

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private get q(): Queue<ProcessJobData> {
    this.queue ??= new Queue<ProcessJobData>(QUEUE_NAME, { connection: redisConnection(this.cfg.REDIS_URL, false) });
    this.queue.on('error', () => undefined); // surfaced via enqueue() errors instead
    return this.queue;
  }

  async enqueue(data: ProcessJobData): Promise<string> {
    const job = await this.q.add('process', data, {
      jobId: data.renderJobId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 200,
    });
    return job.id!;
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.q.client;
      return (await (client as unknown as { ping(): Promise<string> }).ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
  }
}

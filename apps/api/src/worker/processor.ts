import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { PipelineRunner } from '@app/pipeline';
import { createLogger, type AppError } from '@app/shared';
import { resolveSettings, type DeepPartial, type ProjectSettings } from '@app/types';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { toUserError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE_NAME, redisConnection, type ProcessJobData } from '../queue/queue.service';
import { PrismaStore } from './prisma-store';
import { WorkerLock, type LockClient } from './worker-lock';

const RUNNING = ['EXTRACTING', 'CLEANING', 'ANALYZING', 'GENERATING_AUDIO', 'PREPARING_VIDEO', 'RENDERING'] as const;
export const WORKER_LOCK_KEY = `${QUEUE_NAME}:worker-lock`;
const STANDBY_POLL_MS = 5000;

const interruptedError = () => ({
  code: 'INTERRUPTED',
  message: 'Processing was interrupted before it finished.',
  hint: 'Click Resume — finished steps are kept and will not be redone.',
  retryable: true,
});

/**
 * Local processing worker. Runs as its own process (`pnpm dev:worker`) so heavy work never
 * blocks the API. Concurrency = MAX_CONCURRENT_PROJECTS (default 1 on a 16GB Mac); a Redis lock
 * keeps a second worker process on standby instead of running projects in parallel.
 */
@Injectable()
export class ProcessingWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker<ProcessJobData>;
  private lock?: WorkerLock;
  private readonly log = new Logger('Worker');
  private readonly controllers = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private stopping = false;
  private wake?: () => void;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap() {
    this.worker = new Worker<ProcessJobData>(QUEUE_NAME, (job) => this.process(job), {
      connection: redisConnection(this.cfg.REDIS_URL, true),
      concurrency: this.cfg.MAX_CONCURRENT_PROJECTS,
      lockDuration: 120_000,
      maxStalledCount: 0,
      autorun: false, // only once we hold the worker lock
    });
    this.worker.on('error', (e) => this.log.error(`queue error: ${toUserError(e).message}`));
    const worker = this.worker;
    this.lock = new WorkerLock(() => worker.client as unknown as Promise<LockClient>, WORKER_LOCK_KEY);
    if (await this.lock.tryAcquire()) {
      try {
        return await this.start();
      } catch (e) {
        await this.lock.release().catch(() => undefined);
        throw e;
      }
    }
    this.log.warn(`Another worker is already running (${(await this.lock.holder()) ?? 'unknown'}). This one stays on standby and takes over when it stops.`);
    void this.standby();
  }

  private async standby() {
    try {
      while (!this.stopping) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, STANDBY_POLL_MS);
          this.wake = () => (clearTimeout(t), r());
        });
        if (!this.stopping && (await this.lock!.tryAcquire())) return await this.start();
      }
    } catch (e) {
      this.log.error(`Worker failed to start: ${toUserError(e).message}`);
      process.exit(1);
    }
  }

  private async start() {
    this.lock!.startRenewal((holder) => this.log.error(`Lost the worker lock to ${holder ?? 'nobody'} — is another worker running?`));
    await this.recoverInterrupted();
    this.worker!.run().catch((e) => this.log.error(`queue error: ${toUserError(e).message}`));
    this.log.log(`Worker ready (concurrency ${this.cfg.MAX_CONCURRENT_PROJECTS}, TTS ${this.cfg.MAX_CONCURRENT_TTS}, render ${this.cfg.MAX_CONCURRENT_PDF_RENDER})`);
  }

  /**
   * A crash / reboot mid-run leaves projects "running". Mark them resumable. Safe because we hold
   * the worker lock: no other worker is running anything, so every claimed run is an orphan.
   */
  private async recoverInterrupted() {
    const orphans = await this.prisma.renderJob.findMany({ where: { status: { in: [...RUNNING] } }, select: { projectId: true } });
    const stuck = await this.prisma.project.findMany({
      // PENDING + claimed run: crashed between claiming the job and the pipeline's first progress write
      where: { OR: [{ status: { in: [...RUNNING] } }, { status: 'PENDING', id: { in: orphans.map((o) => o.projectId) } }] },
      select: { id: true, snapshot: true },
    });
    for (const p of stuck) {
      const error = interruptedError();
      await this.prisma.processingStep.updateMany({ where: { projectId: p.id, status: 'RUNNING' }, data: { status: 'PENDING' } });
      await this.prisma.project.update({
        where: { id: p.id },
        data: { status: 'FAILED', snapshot: { ...((p.snapshot as object) ?? {}), status: 'FAILED', error, message: error.message } as Prisma.InputJsonValue },
      });
      await this.prisma.renderJob.updateMany({ where: { projectId: p.id, status: { in: ['PENDING', ...RUNNING] } }, data: { status: 'FAILED', finishedAt: new Date() } });
    }
    await this.prisma.renderJob.updateMany({ where: { status: { in: [...RUNNING] } }, data: { status: 'FAILED', finishedAt: new Date() } });
    if (stuck.length) this.log.warn(`Marked ${stuck.length} interrupted project(s) as resumable`);
  }

  private process(job: Job<ProcessJobData>): Promise<void> {
    const run = this.runJob(job).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return run;
  }

  private async runJob(job: Job<ProcessJobData>) {
    const { projectId, renderJobId, force } = job.data;
    // Claim the run. Conditional, so it is atomic with a cancel while queued (PENDING → CANCELLED):
    // whichever lands first wins, and a cancelled or deleted run is never started.
    const claim = await this.prisma.renderJob.updateMany({ where: { id: renderJobId, status: 'PENDING' }, data: { status: 'EXTRACTING', startedAt: new Date() } });
    if (claim.count === 0) {
      this.log.log(`Skipping ${projectId}: the run was cancelled or removed before it started`);
      return;
    }
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, include: { document: true } });
    if (!project) return;
    if (this.stopping) {
      // Picked up while shutting down: leave it resumable rather than half-started.
      await this.prisma.renderJob.update({ where: { id: renderJobId }, data: { status: 'FAILED', finishedAt: new Date() } }).catch(() => undefined);
      await this.recordFailure(projectId, toUserError(new Error('shutdown')), true).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(projectId, controller);

    const poll = setInterval(async () => {
      const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { cancelRequested: true } }).catch(() => null);
      if (p?.cancelRequested && !controller.signal.aborted) {
        this.log.log(`Cancelling ${projectId}`);
        controller.abort();
      }
    }, 1500);

    try {
      const settings = resolveSettings(project.settings as DeepPartial<ProjectSettings>);
      const runner = new PipelineRunner(this.cfg, new PrismaStore(this.prisma, projectId), createLogger(`project:${projectId.slice(0, 8)}`, this.cfg.LOG_LEVEL));
      await runner.run(
        { projectId, pdfPath: project.document.filePath, pdfHash: project.document.hash, title: project.name, settings },
        { force, signal: controller.signal },
      );
      await this.prisma.renderJob.update({ where: { id: renderJobId }, data: { status: 'COMPLETED', finishedAt: new Date() } });
    } catch (err) {
      const e = toUserError(err);
      // Stopped by a worker shutdown (Ctrl-C, restart), not by the user: resumable, not "cancelled".
      const interrupted = e.code === 'CANCELLED' && this.stopping;
      await this.prisma.renderJob
        .update({
          where: { id: renderJobId },
          data: { status: e.code === 'CANCELLED' && !interrupted ? 'CANCELLED' : 'FAILED', error: e.toUser() as unknown as Prisma.InputJsonValue, finishedAt: new Date() },
        })
        .catch(() => undefined);
      await this.recordFailure(projectId, e, interrupted).catch(() => undefined);
      // Failure is fully recorded in the DB; don't let BullMQ retry automatically.
    } finally {
      clearInterval(poll);
      this.controllers.delete(projectId);
    }
  }

  /** The runner records its own failures; cover what it cannot (shutdown, or a failure before its first progress write). */
  private async recordFailure(projectId: string, e: AppError, interrupted: boolean) {
    if (interrupted) {
      const error = interruptedError();
      await this.prisma.processingStep.updateMany({ where: { projectId, status: 'RUNNING' }, data: { status: 'PENDING' } });
      const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { snapshot: true } });
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: 'FAILED', snapshot: { ...((p?.snapshot as object) ?? {}), status: 'FAILED', error, message: error.message } as Prisma.InputJsonValue },
      });
      return;
    }
    const status = e.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    await this.prisma.project.updateMany({
      where: { id: projectId, status: 'PENDING' },
      data: {
        status,
        snapshot: { status, progress: 0, message: e.message, error: status === 'FAILED' ? e.toUser() : undefined, updatedAt: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
  }

  async onApplicationShutdown() {
    this.stopping = true;
    this.wake?.();
    for (const c of this.controllers.values()) c.abort();
    // Let aborted runs record their state before a standby worker may take over; the lock uses the
    // worker's Redis connection, so free it before close() quits that connection.
    await Promise.allSettled([...this.inflight]);
    const released = this.lock?.release().catch(() => undefined);
    await Promise.race([released, new Promise((r) => setTimeout(r, 3000).unref())]);
    await this.worker?.close().catch(() => undefined);
  }
}

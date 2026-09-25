import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { PipelineRunner } from '@app/pipeline';
import { createLogger } from '@app/shared';
import { resolveSettings, type DeepPartial, type ProjectSettings } from '@app/types';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { toUserError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE_NAME, redisConnection, type ProcessJobData } from '../queue/queue.service';
import { PrismaStore } from './prisma-store';

const RUNNING = ['EXTRACTING', 'CLEANING', 'ANALYZING', 'GENERATING_AUDIO', 'PREPARING_VIDEO', 'RENDERING'] as const;

/**
 * Local processing worker. Runs as its own process (`pnpm dev:worker`) so heavy work never
 * blocks the API. Concurrency = MAX_CONCURRENT_PROJECTS (default 1 on a 16GB Mac).
 */
@Injectable()
export class ProcessingWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker<ProcessJobData>;
  private readonly log = new Logger('Worker');
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap() {
    await this.recoverInterrupted();
    this.worker = new Worker<ProcessJobData>(QUEUE_NAME, (job) => this.process(job), {
      connection: redisConnection(this.cfg.REDIS_URL, true),
      concurrency: this.cfg.MAX_CONCURRENT_PROJECTS,
      lockDuration: 120_000,
      maxStalledCount: 0,
    });
    this.worker.on('error', (e) => this.log.error(`queue error: ${toUserError(e).message}`));
    this.log.log(`Worker ready (concurrency ${this.cfg.MAX_CONCURRENT_PROJECTS}, TTS ${this.cfg.MAX_CONCURRENT_TTS}, render ${this.cfg.MAX_CONCURRENT_PDF_RENDER})`);
  }

  /** A crash / reboot mid-run leaves projects "running". Mark them resumable. */
  private async recoverInterrupted() {
    const stuck = await this.prisma.project.findMany({ where: { status: { in: [...RUNNING] } }, select: { id: true, snapshot: true } });
    for (const p of stuck) {
      const error = {
        code: 'INTERRUPTED',
        message: 'Processing was interrupted before it finished.',
        hint: 'Click Resume — finished steps are kept and will not be redone.',
        retryable: true,
      };
      await this.prisma.processingStep.updateMany({ where: { projectId: p.id, status: 'RUNNING' }, data: { status: 'PENDING' } });
      await this.prisma.project.update({
        where: { id: p.id },
        data: { status: 'FAILED', snapshot: { ...((p.snapshot as object) ?? {}), status: 'FAILED', error, message: error.message } as Prisma.InputJsonValue },
      });
      await this.prisma.renderJob.updateMany({ where: { projectId: p.id, status: { in: ['PENDING', ...RUNNING] } }, data: { status: 'FAILED', finishedAt: new Date() } });
    }
    if (stuck.length) this.log.warn(`Marked ${stuck.length} interrupted project(s) as resumable`);
  }

  private async process(job: Job<ProcessJobData>) {
    const { projectId, renderJobId, force } = job.data;
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, include: { document: true } });
    if (!project) return;
    const controller = new AbortController();
    this.controllers.set(projectId, controller);
    await this.prisma.project.update({ where: { id: projectId }, data: { cancelRequested: false } });
    await this.prisma.renderJob.update({ where: { id: renderJobId }, data: { status: 'EXTRACTING', startedAt: new Date() } });

    const poll = setInterval(async () => {
      const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { cancelRequested: true } }).catch(() => null);
      if (p?.cancelRequested && !controller.signal.aborted) {
        this.log.log(`Cancelling ${projectId}`);
        controller.abort();
      }
    }, 1500);

    const settings = resolveSettings(project.settings as DeepPartial<ProjectSettings>);
    const runner = new PipelineRunner(this.cfg, new PrismaStore(this.prisma, projectId), createLogger(`project:${projectId.slice(0, 8)}`, this.cfg.LOG_LEVEL));
    try {
      await runner.run(
        { projectId, pdfPath: project.document.filePath, pdfHash: project.document.hash, title: project.name, settings },
        { force, signal: controller.signal },
      );
      await this.prisma.renderJob.update({ where: { id: renderJobId }, data: { status: 'COMPLETED', finishedAt: new Date() } });
    } catch (err) {
      const e = toUserError(err);
      await this.prisma.renderJob
        .update({ where: { id: renderJobId }, data: { status: e.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', error: e.toUser() as unknown as Prisma.InputJsonValue, finishedAt: new Date() } })
        .catch(() => undefined);
      // Failure is fully recorded in the DB; don't let BullMQ retry automatically.
    } finally {
      clearInterval(poll);
      this.controllers.delete(projectId);
    }
  }

  async onApplicationShutdown() {
    for (const c of this.controllers.values()) c.abort();
    await this.worker?.close().catch(() => undefined);
  }
}

import type { Prisma } from '@prisma/client';
import { PerformanceController, PythonPool, type ShortStage, machineInfo, renderShort } from '@app/pipeline';
import { createLogger, describeError } from '@app/shared';
import type { ShortSettings } from '@app/types';
import type { AppConfig } from '../common/config.provider';
import { toUserError } from '../common/errors';
import type { PrismaService } from '../prisma/prisma.service';
import { readPerformancePrefs } from '../system/performance.service';
import type { ShortSnapshot } from '../shorts/shorts.service';

/** Overall progress: where each stage starts and how much of the bar it covers. */
const STAGES: Record<ShortStage, { from: number; span: number; status: 'GENERATING_AUDIO' | 'RENDERING'; message: string }> = {
  narration: { from: 0, span: 0.45, status: 'GENERATING_AUDIO', message: 'Narrating the script…' },
  audio: { from: 0.45, span: 0.05, status: 'GENERATING_AUDIO', message: 'Mastering the audio…' },
  video: { from: 0.5, span: 0.45, status: 'RENDERING', message: 'Drawing the captions…' },
  finishing: { from: 0.95, span: 0.05, status: 'RENDERING', message: 'Finishing the video…' },
};

export const interruptedShort = (): ShortSnapshot => ({
  message: 'Rendering was interrupted before it finished.',
  error: { code: 'INTERRUPTED', message: 'Rendering was interrupted before it finished.', hint: 'Render it again — the narration is kept.', retryable: true },
});

/**
 * Renders one YouTube Short (a job on the `shorts` queue). The Python process narrates and then
 * draws the frames; it honours the power mode (pause, efficiency cores) like a book's pools.
 */
export class ShortsProcessor {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async run(shortId: string, stopping: () => boolean): Promise<void> {
    // Claim: only a queued short starts (a cancel while queued set it to CANCELLED).
    const claim = await this.prisma.short.updateMany({
      where: { id: shortId, status: 'PENDING', cancelRequested: false },
      data: { status: 'GENERATING_AUDIO', progress: 0, snapshot: { stage: 'narration', message: STAGES.narration.message } satisfies ShortSnapshot },
    });
    if (!claim.count) return;
    const short = await this.prisma.short.findUnique({ where: { id: shortId } });
    if (!short) return;
    const log = createLogger(`short:${shortId.slice(0, 8)}`, this.cfg.LOG_LEVEL);
    const controller = new AbortController();
    this.controllers.set(shortId, controller);
    const poll = setInterval(async () => {
      const s = await this.prisma.short.findUnique({ where: { id: shortId }, select: { cancelRequested: true } }).catch(() => null);
      if ((!s || s.cancelRequested) && !controller.signal.aborted) controller.abort();
    }, 1500);

    const performance = new PerformanceController(
      machineInfo(this.cfg.MAX_CONCURRENT_TTS, this.cfg.MAX_CONCURRENT_PDF_RENDER),
      await readPerformancePrefs(this.prisma, this.cfg),
      () => readPerformancePrefs(this.prisma, this.cfg).catch(() => undefined),
      log.child('power'),
    );
    const pool = new PythonPool(this.cfg, 1, {}, log.child('py'));
    let last = 0;
    let stage: ShortStage = 'narration';
    const report = (s: ShortStage, fraction: number) => {
      const st = STAGES[s];
      const now = Date.now();
      if (s === stage && now - last < 700 && fraction < 1) return;
      stage = s;
      last = now;
      const progress = Math.min(0.999, st.from + st.span * Math.min(1, Math.max(0, fraction)));
      void this.prisma.short
        .update({ where: { id: shortId }, data: { status: st.status, progress, snapshot: { stage: s, message: st.message } satisfies ShortSnapshot } })
        .catch(() => undefined);
    };
    try {
      await performance.start();
      performance.attach(pool, 'tts');
      const settings = short.settings as unknown as ShortSettings;
      const result = await renderShort(this.cfg, { id: shortId, title: short.title, script: short.script, settings }, { pool, signal: controller.signal, onProgress: report });
      await this.prisma.short.update({
        where: { id: shortId },
        data: { status: 'COMPLETED', progress: 1, durationSec: result.durationSec, renderedKey: result.key, snapshot: { message: 'Ready to upload.' } satisfies ShortSnapshot },
      });
      log.info(`Short ready (${result.durationSec.toFixed(1)} s)`);
    } catch (err) {
      const e = toUserError(err);
      const interrupted = e.code === 'CANCELLED' && stopping();
      const status = e.code === 'CANCELLED' && !interrupted ? 'CANCELLED' : 'FAILED';
      if (status === 'FAILED' && !interrupted) log.error(`Short failed: ${describeError(err)}`);
      const snapshot: ShortSnapshot = interrupted ? interruptedShort() : status === 'CANCELLED' ? { message: 'Cancelled.' } : { message: e.message, error: e.toUser() };
      await this.prisma.short
        .update({ where: { id: shortId }, data: { status, cancelRequested: false, snapshot: snapshot as unknown as Prisma.InputJsonValue } })
        .catch(() => undefined); // deleted while rendering
    } finally {
      clearInterval(poll);
      this.controllers.delete(shortId);
      performance.detach(pool);
      await pool.shutdown().catch(() => undefined);
      await performance.stop().catch(() => undefined);
    }
  }

  abortAll() {
    for (const c of this.controllers.values()) c.abort();
  }

  /** After a crash: shorts left "rendering" by a dead worker. */
  async recoverInterrupted(): Promise<number> {
    const r = await this.prisma.short.updateMany({
      where: { status: { in: ['GENERATING_AUDIO', 'RENDERING'] } },
      data: { status: 'FAILED', snapshot: interruptedShort() as unknown as Prisma.InputJsonValue },
    });
    return r.count;
  }
}


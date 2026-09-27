import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MODE_SPEED, isOnBattery, machineInfo, planResources } from '@app/pipeline';
import { DEFAULT_PERFORMANCE, PERFORMANCE_MODES, type PerformanceMode, type PerformancePrefs, type PerformanceStatus } from '@app/types';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export const PERFORMANCE_KEY = 'performance';

const LABELS: Record<PerformanceMode, { label: string; description: string }> = {
  silent: { label: 'Silent', description: 'Efficiency cores only — no fan, but several times slower. For overnight runs.' },
  quiet: { label: 'Cool & quiet', description: 'About 2 cores. The Mac stays cool; takes roughly twice as long.' },
  balanced: { label: 'Balanced', description: 'About 4 cores. Nearly full speed without maxing out the CPU.' },
  fast: { label: 'Fast', description: 'All the cores allowed in .env. Hot and loud on a laptop.' },
};

const prefsSchema = z
  .object({ mode: z.enum(PERFORMANCE_MODES as [PerformanceMode, ...PerformanceMode[]]), quietOnBattery: z.boolean(), paused: z.boolean() })
  .partial()
  .strict();

/** Reads the stored preferences (falls back to .env). Shared by the API and the worker. */
export async function readPerformancePrefs(prisma: PrismaService, cfg: AppConfig): Promise<PerformancePrefs> {
  const base: PerformancePrefs = { ...DEFAULT_PERFORMANCE, mode: cfg.PERFORMANCE_MODE, quietOnBattery: cfg.QUIET_ON_BATTERY };
  // Never fail a book because the power setting can't be read: fall back to .env.
  const row = await Promise.resolve()
    .then(() => prisma.appSetting.findUnique({ where: { key: PERFORMANCE_KEY } }))
    .catch(() => null);
  return { ...base, ...((row?.value as Partial<PerformancePrefs> | null) ?? {}) };
}

@Injectable()
export class PerformanceService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async status(): Promise<PerformanceStatus> {
    const prefs = await readPerformancePrefs(this.prisma, this.cfg);
    const plan = planResources(prefs, machineInfo(this.cfg.MAX_CONCURRENT_TTS, this.cfg.MAX_CONCURRENT_PDF_RENDER), await isOnBattery());
    const modes = PERFORMANCE_MODES.map((mode) => ({ mode, ...LABELS[mode], ttsSpeed: MODE_SPEED[mode].tts, videoSpeed: MODE_SPEED[mode].video, cores: MODE_SPEED[mode].cores }));
    return { prefs, plan, modes };
  }

  /** Change the power mode / pause. A running worker applies it within ~3 s. */
  async update(body: unknown): Promise<PerformanceStatus> {
    const parsed = prefsSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid power setting: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`);
    const next = { ...(await readPerformancePrefs(this.prisma, this.cfg)), ...parsed.data };
    await this.prisma.appSetting.upsert({
      where: { key: PERFORMANCE_KEY },
      create: { key: PERFORMANCE_KEY, value: next as unknown as Prisma.InputJsonValue },
      update: { value: next as unknown as Prisma.InputJsonValue },
    });
    return this.status();
  }
}

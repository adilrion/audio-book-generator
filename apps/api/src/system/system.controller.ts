import { Controller, Get, Inject, Query } from '@nestjs/common';
import { DEFAULT_VOICES, checkLocalEnvironment, createTTSProvider, ttsEngineNames } from '@app/pipeline';
import { DEFAULT_SETTINGS, type HealthCheck, type HealthReport, type VoiceInfo } from '@app/types';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { PythonService } from './python.service';

@Controller('system')
export class SystemController {
  private healthCache?: { at: number; report: HealthReport };

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly python: PythonService,
  ) {}

  @Get('health')
  async health(@Query('fresh') fresh?: string): Promise<HealthReport> {
    if (!fresh && this.healthCache && Date.now() - this.healthCache.at < 15_000) return this.healthCache.report;
    const checks: HealthCheck[] = [];
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.push({ name: 'Database (PostgreSQL)', ok: true, required: true, message: 'connected' });
    } catch {
      checks.push({ name: 'Database (PostgreSQL)', ok: false, required: true, message: 'not reachable', fix: 'docker compose up -d postgres' });
    }
    const redis = await this.queue.ping();
    checks.push({ name: 'Job queue (Redis)', ok: redis, required: true, message: redis ? 'connected' : 'not reachable', fix: redis ? undefined : 'docker compose up -d redis' });
    checks.push(...(await checkLocalEnvironment(this.cfg)));
    const report = { ok: checks.every((c) => c.ok || !c.required), checks };
    this.healthCache = { at: Date.now(), report };
    return report;
  }

  @Get('voices')
  async voices(@Query('engine') engine?: string): Promise<{ engine: string; available: boolean; message: string; voices: VoiceInfo[] }> {
    const name = engine ?? this.cfg.TTS_ENGINE;
    const engines = ttsEngineNames();
    if (!engines.includes(name)) throw badRequest(`Unknown voice engine "${name.slice(0, 40)}".`, `Choose one of: ${engines.join(', ')}.`);
    const provider = createTTSProvider(name, this.python.pool);
    const st = await provider.isAvailable();
    return { engine: name, available: st.ok, message: st.message, voices: st.ok ? await provider.listVoices() : [] };
  }

  @Get('config')
  config() {
    return {
      defaults: { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts, engine: this.cfg.TTS_ENGINE, voice: this.cfg.TTS_DEFAULT_VOICE } },
      engines: ttsEngineNames(),
      defaultVoices: DEFAULT_VOICES,
      llm: { enabled: this.cfg.LLM_ENABLED, model: this.cfg.OLLAMA_MODEL },
      maxUploadMb: this.cfg.MAX_UPLOAD_MB,
    };
  }
}

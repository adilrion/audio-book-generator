import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@app/config';
import {
  AppError,
  CancelledError,
  assertDiskSpace,
  atomicWrite,
  atomicWriteJson,
  exists,
  fileSize,
  formatDuration,
  hashKey,
  mapLimit,
  readJson,
  readJsonIfExists,
  readJsonLines,
  rmrf,
  toAppError,
  type Logger,
  silentLogger,
} from '@app/shared';
import {
  STAGE_STATUS,
  STAGE_WEIGHTS,
  type Analysis,
  type Chapter,
  type ChapterAudio,
  type ExtractedPage,
  type ExtractionMeta,
  type JobStatus,
  type ProgressSnapshot,
  type ProjectSettings,
  type Stage,
  type StepRecord,
  type Timeline,
} from '@app/types';
import { masterAudio, muxFinal, validateOutput } from '../audio/ffmpeg';
import { LLMHelper } from '../llm/helper';
import { OllamaProvider } from '../llm/ollama';
import type { LLMProvider } from '../llm/provider';
import { PythonPool } from '../python/bridge';
import { ANALYZER_VERSION, analyzeCleaned, cleanDocument } from '../text/analyze';
import { buildTimeline } from '../timeline/build';
import { buildCues, toSrt, youtubeChapters } from '../timeline/subtitles';
import { createTTSProvider } from '../tts/registry';
import type { TTSProvider, TTSSegment } from '../tts/types';
import { CachePaths, type ProjectManifest } from './paths';
import type { OutputRecord, PipelineStore } from './store';

export const EXTRACT_VERSION = 'extract-v1';
export const TTS_VERSION = 'tts-v1';
export const RENDER_VERSION = 'render-v1';

export interface PipelineJob {
  projectId: string;
  pdfPath: string;
  pdfHash: string;
  title: string;
  settings: ProjectSettings;
  password?: string;
}

export interface RunOptions {
  /** Ignore all caches and recompute everything ("Restart project"). */
  force?: boolean;
  signal?: AbortSignal;
}

export interface RunnerDeps {
  /** Override LLM (tests / other runtimes). `null` disables the LLM. */
  llm?: LLMProvider | null;
  /** Override TTS provider creation (tests). */
  tts?: (engine: string, pool: PythonPool) => TTSProvider;
  /** Called on every snapshot (e.g. CLI progress bar). */
  onSnapshot?: (s: ProgressSnapshot, steps: StepRecord[]) => void;
}

export interface PipelineResult {
  outputs: OutputRecord[];
  durationSec: number;
  analysis: Analysis;
  timeline: Timeline;
  warnings: string[];
}

const chapterLabel = (c: Chapter) => `Chapter ${c.index + 1}`;

export class PipelineRunner {
  private readonly paths: CachePaths;
  private steps = new Map<string, StepRecord>();
  private stageProgress = new Map<Stage, number>();
  private activeStages: Stage[] = [];
  private snapshot: ProgressSnapshot = { status: 'PENDING', progress: 0, updatedAt: new Date().toISOString() };
  private lastFlush = 0;
  private flushTimer?: NodeJS.Timeout;
  private warnings: string[] = [];
  private force = false;
  private signal?: AbortSignal;
  private pools: PythonPool[] = [];

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: PipelineStore,
    private readonly log: Logger = silentLogger,
    private readonly deps: RunnerDeps = {},
  ) {
    this.paths = new CachePaths(cfg);
  }

  // ───────────────────────── progress & steps ─────────────────────────

  private checkCancelled() {
    if (this.signal?.aborted) throw new CancelledError();
  }

  private overall(): number {
    const total = this.activeStages.reduce((n, s) => n + STAGE_WEIGHTS[s], 0) || 1;
    const done = this.activeStages.reduce((n, s) => n + STAGE_WEIGHTS[s] * (this.stageProgress.get(s) ?? 0), 0);
    return Math.min(100, Math.round((done / total) * 1000) / 10);
  }

  private emit(patch: Partial<ProgressSnapshot>, force = false) {
    this.snapshot = { ...this.snapshot, ...patch, progress: this.overall(), warnings: this.warnings, updatedAt: new Date().toISOString() };
    this.deps.onSnapshot?.(this.snapshot, [...this.steps.values()]);
    const now = Date.now();
    if (force || now - this.lastFlush > 700) {
      this.lastFlush = now;
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      void this.store.updateSnapshot(this.snapshot).catch((e) => this.log.warn('snapshot write failed', e));
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.lastFlush = Date.now();
        void this.store.updateSnapshot(this.snapshot).catch(() => undefined);
      }, 700);
    }
  }

  private setStage(stage: Stage, frac: number, message?: string, extra: Partial<ProgressSnapshot> = {}) {
    this.stageProgress.set(stage, Math.max(0, Math.min(1, frac)));
    this.emit({ status: STAGE_STATUS[stage], stage, message, ...extra });
  }

  private defineStep(key: string, stage: Stage, chapterIndex?: number): StepRecord {
    const existing = this.steps.get(key);
    const step: StepRecord = existing ?? { key, stage, status: 'PENDING', progress: 0, chapterIndex };
    this.steps.set(key, step);
    return step;
  }

  private async saveStep(step: StepRecord) {
    this.steps.set(step.key, step);
    await this.store.updateStep(step);
    this.deps.onSnapshot?.(this.snapshot, [...this.steps.values()]);
  }

  /** Run one persisted step: RUNNING → COMPLETED (cached?) | FAILED with a user-facing error. */
  private async step<T>(key: string, stage: Stage, fn: (report: (p: number, msg?: string) => void) => Promise<{ value: T; cached: boolean; message?: string }>, chapterIndex?: number): Promise<T> {
    this.checkCancelled();
    const step = this.defineStep(key, stage, chapterIndex);
    await this.saveStep({ ...step, status: 'RUNNING', progress: 0, startedAt: new Date().toISOString(), error: undefined, finishedAt: undefined });
    let lastSaved = 0;
    const report = (p: number) => {
      const s = this.steps.get(key)!;
      s.progress = Math.round(p * 100);
      if (Date.now() - lastSaved > 2000) {
        lastSaved = Date.now();
        void this.store.updateStep(s).catch(() => undefined);
      }
    };
    try {
      const { value, cached, message } = await fn(report);
      await this.saveStep({ ...this.steps.get(key)!, status: 'COMPLETED', progress: 100, cached, message, finishedAt: new Date().toISOString() });
      return value;
    } catch (err) {
      const e = toAppError(err);
      e.stepKey ??= key;
      if (chapterIndex !== undefined) e.chapterIndex ??= chapterIndex;
      await this.saveStep({
        ...this.steps.get(key)!,
        status: e.code === 'CANCELLED' ? 'PENDING' : 'FAILED',
        error: e.code === 'CANCELLED' ? undefined : e.toUser(),
        finishedAt: new Date().toISOString(),
      });
      throw e;
    }
  }

  private async skipStep(key: string, stage: Stage, message: string) {
    const s = this.defineStep(key, stage);
    await this.saveStep({ ...s, status: 'SKIPPED', progress: 100, message });
  }

  private hit(p: string): Promise<boolean> {
    return this.force ? Promise.resolve(false) : exists(p);
  }

  private pool(size: number, env: Record<string, string> = {}): PythonPool {
    const p = new PythonPool(this.cfg, size, env, this.log.child('py'));
    this.pools.push(p);
    return p;
  }

  // ───────────────────────────── main ─────────────────────────────

  async run(job: PipelineJob, opts: RunOptions = {}): Promise<PipelineResult> {
    this.force = !!opts.force;
    this.signal = opts.signal;
    const s = job.settings;
    const video = s.outputMode === 'audiobook_video';
    this.activeStages = video
      ? ['EXTRACT', 'CLEAN', 'ANALYZE', 'TTS', 'AUDIO_MERGE', 'TIMELINE', 'VIDEO', 'MUX']
      : ['EXTRACT', 'CLEAN', 'ANALYZE', 'TTS', 'AUDIO_MERGE', 'TIMELINE'];

    for (const st of await this.store.loadSteps()) this.steps.set(st.key, st);
    const outDir = this.paths.output(job.projectId);
    const workDir = this.paths.work(job.projectId);
    await fsp.mkdir(workDir, { recursive: true });
    const manifestFile = path.join(outDir, 'manifest.json');
    const manifest: ProjectManifest = (await readJsonIfExists<ProjectManifest>(manifestFile)) ?? { pdfHash: job.pdfHash, audioKeys: [], videoKeys: [] };
    const saveManifest = () => atomicWriteJson(manifestFile, manifest, true);

    const mainPool = this.pool(1);
    try {
      this.emit({ status: 'EXTRACTING', message: 'Starting', error: undefined }, true);

      // ── 1. EXTRACT ─────────────────────────────────────────
      const extractKey = hashKey(EXTRACT_VERSION, job.pdfHash, s.text.ocr, s.language);
      const exDir = this.paths.extraction(job.pdfHash, extractKey);
      const meta = await this.step('EXTRACT', 'EXTRACT', async (report) => {
        const metaFile = path.join(exDir, 'meta.json');
        if (await this.hit(metaFile)) {
          this.setStage('EXTRACT', 1, 'PDF already analyzed (cached)');
          return { value: await readJson<ExtractionMeta>(metaFile), cached: true };
        }
        await assertDiskSpace(this.cfg.storage.root, (await fileSize(job.pdfPath)) * 3, this.cfg.DISK_RESERVE_GB * 1e9, 'text extraction');
        const m = await mainPool.call<ExtractionMeta>(
          'pdf.extract',
          { path: job.pdfPath, outDir: exDir, pdfHash: job.pdfHash, ocr: s.text.ocr, ocrLanguage: s.language === 'bn' ? 'ben' : 'eng', password: job.password },
          {
            signal: this.signal,
            onProgress: (p) => {
              report(p.done / p.total);
              this.setStage('EXTRACT', p.done / p.total, p.message ?? `Reading page ${p.done} of ${p.total}`);
            },
          },
        );
        if (m.emptyPages.length > m.pageCount * 0.3)
          this.warnings.push(`${m.emptyPages.length} pages had no readable text${m.ocrPages.length ? '' : ' (install tesseract for OCR)'}.`);
        return { value: m, cached: false, message: `${m.pageCount} pages, ${m.wordCount.toLocaleString()} words` };
      });
      manifest.extractKey = extractKey;
      this.setStage('EXTRACT', 1, 'PDF analysis done');

      // ── 2+3. CLEAN + ANALYZE ────────────────────────────────
      const llm = await this.makeLlm(s);
      const analysisKey = hashKey(ANALYZER_VERSION, extractKey, s.language, s.text.skipFrontMatter, llm ? llm.model : 'none', !!(llm && this.cfg.LLM_PRONUNCIATION));
      const analysisFile = this.paths.analysis(job.pdfHash, analysisKey);
      let analysis: Analysis;
      if (await this.hit(analysisFile)) {
        analysis = await readJson<Analysis>(analysisFile);
        await this.step('CLEAN', 'CLEAN', async () => ({ value: null, cached: true }));
        this.setStage('CLEAN', 1, 'Text already cleaned (cached)');
        await this.step('ANALYZE', 'ANALYZE', async () => ({ value: null, cached: true, message: `${analysis.chapters.length} chapters` }));
      } else {
        const clean = await this.step('CLEAN', 'CLEAN', async () => {
          this.setStage('CLEAN', 0.1, 'Loading extracted text');
          const pages: ExtractedPage[] = [];
          for await (const p of readJsonLines<ExtractedPage>(path.join(exDir, meta.pagesFile))) pages.push(p);
          this.setStage('CLEAN', 0.5, 'Removing headers, footers and page numbers');
          const c = cleanDocument(pages);
          const r = c.report;
          return { value: c, cached: false, message: `${r.removedHeaders.length + r.removedFooters.length} running headers/footers, ${r.removedPageNumbers} page numbers removed` };
        });
        this.setStage('CLEAN', 1, 'Text cleaned');
        analysis = await this.step('ANALYZE', 'ANALYZE', async (report) => {
          const a = await analyzeCleaned(clean, meta, {
            language: s.language,
            skipFrontMatter: s.text.skipFrontMatter,
            title: job.title,
            llm,
            pronunciation: this.cfg.LLM_PRONUNCIATION,
            signal: this.signal,
            log: this.log,
            onProgress: (d, t, m) => {
              report(d / t);
              this.setStage('ANALYZE', d / t, m);
            },
          });
          await atomicWriteJson(analysisFile, a);
          return { value: a, cached: false, message: `${a.chapters.length} chapters (${a.stats.chapterSource}), ${a.stats.sentences.toLocaleString()} sentences` };
        });
      }
      this.warnings.push(...analysis.warnings.filter((w) => !this.warnings.includes(w)));
      manifest.analysisKey = analysisKey;
      await saveManifest();
      await this.store.saveAnalysis(analysis, analysisKey);
      this.setStage('ANALYZE', 1, `${analysis.chapters.length} chapters found`, { totalChapters: analysis.chapters.length });

      const chapters = this.selectChapters(analysis, s);
      if (!chapters.length) throw new AppError('NO_CHAPTERS', 'The selected chapter range contains no text.', { retryable: false });

      // Register every step up-front so the UI shows the whole plan.
      for (const c of chapters) this.defineStep(`TTS_CHAPTER_${c.index + 1}`, 'TTS', c.index);
      this.defineStep('AUDIO_MERGE', 'AUDIO_MERGE');
      this.defineStep('TIMELINE', 'TIMELINE');
      if (video) {
        for (const c of chapters) this.defineStep(`VIDEO_CHAPTER_${c.index + 1}`, 'VIDEO', c.index);
        this.defineStep('MUX', 'MUX');
      }
      await this.store.saveSteps(this.orderedSteps());

      // ── 4. TTS per chapter ─────────────────────────────────
      const audios = await this.runTts(job, chapters);
      manifest.audioKeys = audios.map((a) => a.cacheKey);
      await saveManifest();

      // ── 5. AUDIO MASTER ────────────────────────────────────
      const totalDuration = audios.reduce((n, a) => n + a.samples / a.sampleRate, 0);
      const m4a = path.join(outDir, 'audiobook.m4a');
      const chapterMarks = (() => {
        let t = 0;
        return audios.map((a) => {
          const c = analysis.chapters[a.chapterIndex];
          const mark = { title: c.title, start: t, end: t + a.samples / a.sampleRate };
          t = mark.end;
          return mark;
        });
      })();
      const masterKey = hashKey(manifest.audioKeys, s.audio.normalize, this.cfg.AUDIO_BITRATE, this.cfg.AUDIO_ENCODER, chapterMarks.map((c) => c.title));
      await this.step('AUDIO_MERGE', 'AUDIO_MERGE', async (report) => {
        if (!this.force && manifest.masterKey === masterKey && (await exists(m4a))) return { value: null, cached: true };
        await masterAudio(this.cfg, audios.map((a) => a.file), m4a, {
          normalize: s.audio.normalize,
          title: analysis.title,
          chapters: chapterMarks,
          workDir,
          signal: this.signal,
          onTime: (sec) => {
            report(sec / totalDuration);
            this.setStage('AUDIO_MERGE', sec / totalDuration, 'Mastering audio');
          },
        });
        manifest.masterKey = masterKey;
        manifest.durationSec = totalDuration;
        await saveManifest();
        return { value: null, cached: false };
      });
      this.setStage('AUDIO_MERGE', 1, 'Audio ready');

      // ── 6. TIMELINE + SUBTITLES ────────────────────────────
      const pageSizes: Record<string, [number, number]> = {};
      meta.pageSizes?.forEach((wh, i) => (pageSizes[String(i + 1)] = wh));
      const timelineKey = hashKey(analysisKey, manifest.audioKeys, s.video.fps, s.video.highlightMode);
      const timelineFile = path.join(outDir, 'timeline.json');
      const timeline = await this.step('TIMELINE', 'TIMELINE', async () => {
        if (!this.force && manifest.timelineKey === timelineKey && (await exists(timelineFile)) && (await exists(path.join(outDir, 'subtitles.srt'))))
          return { value: await readJson<Timeline>(timelineFile), cached: true };
        const t = buildTimeline(analysis, audios, { fps: s.video.fps, highlightMode: s.video.highlightMode, pageSizes });
        await atomicWriteJson(path.join(outDir, 'timeline.json'), t);
        await atomicWrite(path.join(outDir, 'subtitles.srt'), toSrt(buildCues(analysis, audios)));
        await atomicWrite(path.join(outDir, 'chapters.txt'), youtubeChapters(t.chapters));
        await this.store.saveTimeline(t);
        manifest.timelineKey = timelineKey;
        await saveManifest();
        return { value: t, cached: false, message: `${t.segments.length.toLocaleString()} highlight segments` };
      });
      this.setStage('TIMELINE', 1, 'Timeline ready');

      // ── 7+8. VIDEO + MUX ───────────────────────────────────
      if (video) {
        const plans = this.planVideo(job, timeline, audios, pageSizes);
        const mp4 = path.join(outDir, 'audiobook.mp4');
        const muxKey = hashKey(plans.map((p) => p.key), masterKey, s.video.embedSubtitles, s.language);
        const finalIsCurrent = !this.force && manifest.muxKey === muxKey && (await exists(mp4));
        if (finalIsCurrent) {
          for (const p of plans) await this.step(`VIDEO_CHAPTER_${p.tc.index + 1}`, 'VIDEO', async () => ({ value: null, cached: true }), p.tc.index);
          await this.step('MUX', 'MUX', async () => ({ value: null, cached: true }));
        } else {
          const segs = await this.renderVideo(job, plans, timeline);
          manifest.videoKeys = segs.map((v) => v.key);
          await saveManifest();
          await this.step('MUX', 'MUX', async () => {
            this.setStage('MUX', 0.2, 'Combining video, audio and subtitles');
            await muxFinal(this.cfg, segs.map((v) => v.file), m4a, mp4, {
              srt: s.video.embedSubtitles ? path.join(outDir, 'subtitles.srt') : undefined,
              title: analysis.title,
              chapters: chapterMarks,
              workDir,
              language: s.language,
              signal: this.signal,
            });
            this.setStage('MUX', 0.8, 'Validating output');
            const v = await validateOutput(this.cfg, mp4, totalDuration, s.video.fps);
            manifest.muxKey = muxKey;
            await saveManifest();
            return { value: null, cached: false, message: `A/V drift ${(v.drift * 1000).toFixed(0)} ms` };
          });
          if (!this.cfg.KEEP_INTERMEDIATE) await this.cleanupIntermediate(job, segs.map((v) => v.file));
        }
        this.setStage('VIDEO', 1, 'Video segments ready');
        this.setStage('MUX', 1, 'Video ready');
      } else {
        this.stageProgress.set('VIDEO', 1);
      }

      await rmrf(workDir);
      const outputs = await this.collectOutputs(outDir);
      await this.store.saveOutputs(outputs);
      this.emit({ status: 'COMPLETED', message: 'Done', stage: undefined, stepKey: undefined }, true);
      return { outputs, durationSec: totalDuration, analysis, timeline, warnings: this.warnings };
    } catch (err) {
      const e = toAppError(err);
      const status: JobStatus = e.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      this.log.error(`pipeline ${status.toLowerCase()}: ${e.code} ${e.message}`, (e as Error & { cause?: unknown }).cause ?? e.details);
      this.emit({ status, message: e.message, error: status === 'FAILED' ? e.toUser() : undefined }, true);
      throw e;
    } finally {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      await this.store.updateSnapshot(this.snapshot).catch(() => undefined);
      for (const p of this.pools) {
        if (this.signal?.aborted) p.killAll();
        else await p.shutdown();
      }
      this.pools = [];
    }
  }

  private orderedSteps(): StepRecord[] {
    const order = (s: StepRecord) => this.activeStages.indexOf(s.stage) * 10000 + (s.chapterIndex ?? 0);
    return [...this.steps.values()].sort((a, b) => order(a) - order(b));
  }

  private selectChapters(a: Analysis, s: ProjectSettings): Chapter[] {
    const r = s.text.chapterRange;
    if (!r) return a.chapters;
    return a.chapters.filter((c) => c.index + 1 >= r.from && c.index + 1 <= r.to);
  }

  private async makeLlm(s: ProjectSettings): Promise<LLMHelper | undefined> {
    if (!s.text.useLlm || !this.cfg.LLM_ENABLED || this.deps.llm === null) return undefined;
    const provider = this.deps.llm ?? new OllamaProvider({ baseUrl: this.cfg.OLLAMA_BASE_URL, model: this.cfg.OLLAMA_MODEL, timeoutMs: this.cfg.LLM_TIMEOUT_MS });
    const st = await provider.isAvailable();
    if (!st.ok) {
      this.warnings.push(`Local AI (Ollama) not used: ${st.message}. Continued with rule-based processing.`);
      return undefined;
    }
    return new LLMHelper(provider, this.paths.llmCache(), this.cfg.MAX_CONCURRENT_LLM, this.log.child('llm'));
  }

  // ───────────────────────────── TTS ─────────────────────────────

  static chapterSegments(c: Chapter, s: ProjectSettings): TTSSegment[] {
    const segs: TTSSegment[] = [];
    c.paragraphs.forEach((p, pi) => {
      p.sentences.forEach((st, si) => {
        const lastInPara = si === p.sentences.length - 1;
        const lastInChapter = lastInPara && pi === c.paragraphs.length - 1;
        const pause = lastInChapter
          ? s.audio.chapterPauseMs
          : lastInPara
            ? s.audio.paragraphPauseMs + (p.kind === 'heading' ? 250 : 0)
            : s.audio.sentencePauseMs;
        segs.push({ id: st.id, text: st.narration, pauseMs: pause });
      });
    });
    return segs;
  }

  private async runTts(job: PipelineJob, chapters: Chapter[]): Promise<ChapterAudio[]> {
    const s = job.settings;
    const threads = Math.max(1, Math.floor(this.cfg.cpuCount / this.cfg.MAX_CONCURRENT_TTS));
    const pool = this.pool(this.cfg.MAX_CONCURRENT_TTS, { KOKORO_THREADS: String(threads), OMP_NUM_THREADS: String(threads) });
    const provider = this.deps.tts ? this.deps.tts(s.tts.engine, pool) : createTTSProvider(s.tts.engine, pool);
    const plans = chapters.map((c) => {
      const segments = PipelineRunner.chapterSegments(c, s);
      const key = hashKey(TTS_VERSION, provider.engine, provider.version, s.tts.voice, s.tts.speed, this.cfg.TTS_SAMPLE_RATE, s.language, segments);
      return { c, segments, key, files: this.paths.chapterAudio(key) };
    });
    const total = plans.reduce((n, p) => n + p.segments.length, 0) || 1;
    const done = new Map<number, number>();
    const tick = (label: string, ch: Chapter) => {
      const d = [...done.values()].reduce((a, b) => a + b, 0);
      this.setStage('TTS', d / total, label, { currentChapter: ch.index + 1, totalChapters: chapters.length });
    };

    let checked = false;
    const ensureEngine = async () => {
      if (checked) return;
      checked = true;
      const st = await provider.isAvailable();
      if (!st.ok)
        throw new AppError('TTS_ENGINE_UNAVAILABLE', `The "${provider.engine}" voice engine is not ready.`, { hint: st.message, retryable: true });
      const voices = await provider.listVoices();
      if (voices.length && !voices.some((v) => v.id === s.tts.voice))
        throw new AppError('TTS_VOICE_NOT_FOUND', `The voice "${s.tts.voice}" is not installed for ${provider.engine}.`, {
          hint: `Available voices: ${voices.slice(0, 12).map((v) => v.id).join(', ')}…`,
          retryable: false,
        });
    };

    const missing = [];
    for (const p of plans) if (!(await this.hit(p.files.meta)) || !(await exists(p.files.audio))) missing.push(p);
    if (missing.length) {
      const words = missing.reduce((n, p) => n + p.segments.reduce((m, sg) => m + sg.text.split(/\s+/).length, 0), 0);
      const estSec = (words / 150) * 60;
      await assertDiskSpace(this.cfg.storage.root, estSec * this.cfg.TTS_SAMPLE_RATE * 2 * 0.7, this.cfg.DISK_RESERVE_GB * 1e9, 'audio generation');
    }

    const results = await mapLimit(plans, this.cfg.MAX_CONCURRENT_TTS, async (p) => {
      const label = /^(chapter|part|section)\b/i.test(p.c.title) ? `“${p.c.title}”` : `${chapterLabel(p.c)} “${p.c.title}”`;
      return this.step(
        `TTS_CHAPTER_${p.c.index + 1}`,
        'TTS',
        async (report) => {
          if ((await this.hit(p.files.meta)) && (await exists(p.files.audio))) {
            const cached = { ...(await readJson<ChapterAudio>(p.files.meta)), file: p.files.audio };
            done.set(p.c.index, p.segments.length);
            await this.store.saveChapterAudio(cached);
            tick(`${label} (cached)`, p.c);
            return { value: cached, cached: true };
          }
          await ensureEngine();
          tick(`Narrating ${label}`, p.c);
          try {
            const r = await provider.synthesizeSegments(p.segments, {
              voice: s.tts.voice,
              speed: s.tts.speed,
              language: s.language,
              sampleRate: this.cfg.TTS_SAMPLE_RATE,
              outPath: p.files.audio,
              signal: this.signal,
              onProgress: (ev) => {
                done.set(p.c.index, ev.done);
                report(ev.done / ev.total);
                tick(`Narrating ${label} — sentence ${ev.done}/${ev.total}`, p.c);
              },
            });
            const audio: ChapterAudio = {
              chapterIndex: p.c.index,
              file: r.audioPath,
              sampleRate: r.sampleRate,
              samples: r.samples,
              durationSec: r.durationSec,
              timings: r.sentences ?? [],
              cacheKey: p.key,
              engine: provider.engine,
              voice: s.tts.voice,
            };
            await atomicWriteJson(p.files.meta, audio);
            done.set(p.c.index, p.segments.length);
            await this.store.saveChapterAudio(audio);
            return { value: audio, cached: false, message: formatDuration(r.durationSec) };
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            const base = toAppError(err);
            if (['TTS_ENGINE_UNAVAILABLE', 'TTS_VOICE_NOT_FOUND', 'DISK_SPACE', 'DISK_FULL', 'CANCELLED'].includes(base.code)) throw base;
            throw new AppError('TTS_FAILED', `Audio generation failed for ${chapterLabel(p.c)}.`, {
              hint: `Retry to continue from ${chapterLabel(p.c)} — finished chapters are kept.`,
              chapterIndex: p.c.index,
              retryable: true,
              cause: err,
            });
          }
        },
        p.c.index,
      );
    });
    await pool.shutdown(); // hand Kokoro's memory back before video rendering
    this.setStage('TTS', 1, 'Narration complete');
    return results;
  }

  // ───────────────────────────── VIDEO ─────────────────────────────

  private planVideo(job: PipelineJob, timeline: Timeline, audios: ChapterAudio[], pageSizes: Record<string, [number, number]>) {
    const v = job.settings.video;
    const fps = v.fps;
    return timeline.chapters.map((tc, i) => {
      const segments = timeline.segments.filter((sg) => sg.chapterIndex === tc.index).map((sg) => ({ start: sg.start, end: sg.end, page: sg.page, rects: sg.rects }));
      const frameStart = Math.round(tc.start * fps);
      const frameEnd = Math.round(tc.end * fps);
      const style = {
        animation: v.animation,
        subtleZoom: v.subtleZoom,
        highlightStyle: v.highlightStyle,
        highlightColor: v.highlightColor,
        theme: v.theme,
        showProgress: v.showProgress,
        showChapterTitle: v.showChapterTitle,
      };
      const encoder = { codec: this.cfg.VIDEO_ENCODER, bitrate: this.cfg.VIDEO_BITRATE, crf: this.cfg.VIDEO_CRF, ffmpeg: this.cfg.FFMPEG_BIN };
      const key = hashKey(RENDER_VERSION, audios[i].cacheKey, v.width, v.height, fps, style, encoder, segments, tc.title, frameStart, frameEnd, v.showProgress ? timeline.duration : 0);
      const pages: Record<string, { w: number; h: number }> = {};
      for (const sg of segments) {
        const wh = pageSizes[String(sg.page)] ?? [612, 792];
        pages[String(sg.page)] = { w: wh[0], h: wh[1] };
      }
      return { tc, segments, frameStart, frameEnd, style, encoder, key, pages, file: this.paths.videoSegment(key) };
    });
  }

  private async renderVideo(job: PipelineJob, plans: ReturnType<PipelineRunner['planVideo']>, timeline: Timeline) {
    const v = job.settings.video;
    const fps = v.fps;
    const pool = this.pool(this.cfg.MAX_CONCURRENT_PDF_RENDER, { OMP_NUM_THREADS: '2', OPENCV_NUM_THREADS: '2' });
    const totalFrames = plans.reduce((n, p) => n + (p.frameEnd - p.frameStart), 0) || 1;
    const done = new Map<number, number>();
    const tick = (msg: string, ch: number) =>
      this.setStage('VIDEO', [...done.values()].reduce((a, b) => a + b, 0) / totalFrames, msg, { currentChapter: ch + 1, totalChapters: plans.length });

    const pending = [];
    for (const p of plans) if (!(await this.hit(p.file))) pending.push(p);
    if (pending.length) {
      const bps = parseBitrate(this.cfg.VIDEO_BITRATE);
      const secs = pending.reduce((n, p) => n + (p.frameEnd - p.frameStart) / fps, 0);
      await assertDiskSpace(this.cfg.storage.root, ((secs * bps) / 8) * 2.2 + 400e6, this.cfg.DISK_RESERVE_GB * 1e9, 'video rendering');
    }

    const out = await mapLimit(plans, this.cfg.MAX_CONCURRENT_PDF_RENDER, async (p) =>
      this.step(
        `VIDEO_CHAPTER_${p.tc.index + 1}`,
        'VIDEO',
        async (report) => {
          const n = p.frameEnd - p.frameStart;
          if (await this.hit(p.file)) {
            done.set(p.tc.index, n);
            tick(`Chapter ${p.tc.index + 1} video (cached)`, p.tc.index);
            return { value: { key: p.key, file: p.file }, cached: true };
          }
          const r = await pool.call<{ fpsAchieved: number; codec: string }>(
            'video.render_chapter',
            {
              outPath: p.file,
              width: v.width,
              height: v.height,
              fps,
              frameStart: p.frameStart,
              frameEnd: p.frameEnd,
              totalDuration: timeline.duration,
              chapter: { title: p.tc.title, start: p.tc.start, end: p.tc.end },
              pages: p.pages,
              segments: p.segments,
              style: p.style,
              encoder: p.encoder,
              pdfPath: job.pdfPath,
              password: job.password,
              pageDir: this.paths.pages(job.pdfHash),
            },
            {
              signal: this.signal,
              onProgress: (ev: { done: number; total: number; phase?: string }) => {
                if (ev.phase === 'pages') {
                  tick(`Chapter ${p.tc.index + 1}: rendering pages ${ev.done}/${ev.total}`, p.tc.index);
                  return;
                }
                done.set(p.tc.index, ev.done);
                report(ev.done / ev.total);
                tick(`Rendering chapter ${p.tc.index + 1} — frame ${ev.done.toLocaleString()}/${ev.total.toLocaleString()}`, p.tc.index);
              },
            },
          );
          done.set(p.tc.index, n);
          return { value: { key: p.key, file: p.file }, cached: false, message: `${r.fpsAchieved} fps (${r.codec})` };
        },
        p.tc.index,
      ),
    );
    await pool.shutdown();
    return out;
  }

  private async cleanupIntermediate(job: PipelineJob, segmentFiles: string[]) {
    for (const f of segmentFiles) await rmrf(f);
    await rmrf(this.paths.pages(job.pdfHash));
  }

  private async collectOutputs(outDir: string): Promise<OutputRecord[]> {
    const files: [string, OutputRecord['kind']][] = [
      ['audiobook.mp4', 'video'],
      ['audiobook.m4a', 'audio'],
      ['subtitles.srt', 'subtitles'],
      ['chapters.txt', 'timeline'],
      ['timeline.json', 'timeline'],
    ];
    const out: OutputRecord[] = [];
    for (const [name, kind] of files) {
      const p = path.join(outDir, name);
      const size = await fileSize(p);
      if (size > 0) out.push({ name, kind, size, path: p });
    }
    return out;
  }
}

function parseBitrate(b: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(b.trim());
  if (!m) return 6e6;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'm' ? n * 1e6 : m[2].toLowerCase() === 'k' ? n * 1e3 : n;
}

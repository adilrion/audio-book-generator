import fsp from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Short } from '@prisma/client';
import { CachePaths, OllamaProvider, type ShortScriptSource, canNarrate, generateShortMetadata, generateShortScript, isFrontMatterTitle, shortImages, shortRenderKey, voiceAfterChange } from '@app/pipeline';
import { AppError, atomicWrite, ensureDir, exists, formatDuration, rmrf } from '@app/shared';
import {
  DEFAULT_SHORT_LOOK,
  SHORT_MAX_SEC,
  estimateShortSec,
  fitTags,
  suggestShortTags,
  type JobStatus,
  type LanguageCode,
  type OutputFile,
  type ShortDetail,
  type ShortMetadataResult,
  type ShortScriptResult,
  type ShortSettings,
  type ShortSummary,
  type ShortThumbnail,
  type UserFacingError,
} from '@app/types';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest, cannotNarrate, conflict, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { QueueService } from '../queue/queue.service';
import { issues, metadataSchema, scriptRequestSchema, shortInputSchema, shortSettingsSchema, shortUpdateSchema } from './shorts.schema';

/** While one of these, a short is being worked on. */
export const SHORT_ACTIVE: JobStatus[] = ['GENERATING_AUDIO', 'RENDERING'];
const SAFE_ID = /^[a-z0-9-]+$/i;
/** Files a short's folder may serve (cover.jpg and .work/ are internal). */
const FILES: Record<string, OutputFile['kind']> = { 'short.mp4': 'video', 'short.srt': 'subtitles', 'thumbnail.jpg': 'image' };
/** Fields that do not change the video: they may be edited while it renders. */
const METADATA_FIELDS = ['description', 'hashtags', 'tags', 'thumbnail'];
const WITH_BOOK = { project: { select: { name: true, document: { select: { author: true } } } } } as const;

export interface ShortSnapshot {
  stage?: string;
  message?: string;
  error?: UserFacingError;
  /** PENDING because it waits in the queue (not a draft). */
  queued?: boolean;
}

type ShortWithBook = Short & { project: { name: string; document: { author: string | null } } | null };
type Book = { name: string; document: { author: string | null } };

@Injectable()
export class ShortsService {
  private readonly paths: CachePaths;
  private readonly log = new Logger('Shorts');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly projects: ProjectsService,
  ) {
    this.paths = new CachePaths(cfg);
  }

  defaults(): ShortSettings {
    return { language: 'en', tts: { engine: this.cfg.TTS_ENGINE, voice: this.cfg.TTS_DEFAULT_VOICE, speed: 1 }, look: { ...DEFAULT_SHORT_LOOK } };
  }

  /** Stored settings with anything missing (older rows) filled from the defaults. */
  resolve(raw: unknown): ShortSettings {
    const d = this.defaults();
    const s = (raw ?? {}) as Partial<ShortSettings>;
    return { language: s.language ?? d.language, tts: { ...d.tts, ...s.tts }, look: { ...d.look, ...s.look } };
  }

  /** Validated settings merged over `base`; the project rules for language and voice apply. */
  parseSettings(raw: unknown, base: ShortSettings = this.defaults()): ShortSettings {
    const parsed = shortSettingsSchema.safeParse(raw ?? {});
    if (!parsed.success) throw badRequest(`Invalid settings: ${issues(parsed.error)}`);
    const p = parsed.data;
    const merged: ShortSettings = { language: (p.language ?? base.language) as LanguageCode, tts: { ...base.tts, ...p.tts }, look: { ...base.look, ...p.look } };
    merged.tts = voiceAfterChange(p, merged);
    if (!canNarrate(merged.tts.engine, merged.language)) throw cannotNarrate(merged.tts.engine, merged.language);
    return merged;
  }

  // ── read ─────────────────────────────────────────────────
  async list(): Promise<ShortSummary[]> {
    const rows = await this.prisma.short.findMany({ include: WITH_BOOK, orderBy: { createdAt: 'desc' }, take: 200 });
    const thumbs = await Promise.all(rows.map((s) => this.thumbnailVersion(s.id)));
    return rows.map((s, i) => this.summary(s, thumbs[i]));
  }

  /** Changes with every saved thumbnail (cache-busting); undefined without one. */
  private async thumbnailVersion(id: string): Promise<string | undefined> {
    const st = await fsp.stat(this.thumbnailPath(id)).catch(() => null);
    return st ? `${st.size.toString(36)}${Math.round(st.mtimeMs).toString(36)}` : undefined;
  }

  private summary(s: ShortWithBook, thumbnailVersion?: string): ShortSummary {
    const settings = this.resolve(s.settings);
    const snap = (s.snapshot ?? {}) as ShortSnapshot;
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      queued: s.status === 'PENDING' && !!snap.queued,
      progress: s.progress,
      durationSec: s.durationSec ?? undefined,
      language: settings.language,
      theme: settings.look.theme,
      projectId: s.projectId ?? undefined,
      bookTitle: s.project?.name,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      version: s.renderedKey?.slice(0, 12),
      thumbnailVersion,
    };
  }

  private async get(id: string): Promise<ShortWithBook> {
    if (!SAFE_ID.test(id)) throw notFound('Short');
    const s = await this.prisma.short.findUnique({ where: { id }, include: WITH_BOOK });
    if (!s) throw notFound('Short');
    return s;
  }

  async detail(id: string): Promise<ShortDetail> {
    const s = await this.get(id);
    const settings = this.resolve(s.settings);
    const snap = (s.snapshot ?? {}) as ShortSnapshot;
    const images = await shortImages(this.cfg, id, settings.look);
    return {
      ...this.summary(s, await this.thumbnailVersion(id)),
      script: s.script,
      description: s.description,
      hashtags: s.hashtags,
      tags: s.tags,
      thumbnail: (s.thumbnail as unknown as ShortThumbnail | null) ?? undefined,
      bookAuthor: s.project?.document.author ?? undefined,
      settings,
      message: snap.message,
      error: snap.error,
      outputs: await this.outputs(id),
      stale: s.status === 'COMPLETED' && !!s.renderedKey && s.renderedKey !== shortRenderKey({ title: s.title, script: s.script, settings }, !!images.cover, images.introStamp),
    };
  }

  private async outputs(id: string): Promise<OutputFile[]> {
    const out: OutputFile[] = [];
    for (const [name, kind] of Object.entries(FILES)) {
      const st = await fsp.stat(path.join(this.paths.short(id), name)).catch(() => null);
      if (st) out.push({ name, kind, size: st.size, url: `/shorts/${id}/output/${name}` });
    }
    return out;
  }

  outputPath(id: string, name: string): string {
    if (!SAFE_ID.test(id) || !(name in FILES)) throw notFound('File');
    return path.join(this.paths.short(id), name);
  }

  private coverPath(id: string) {
    return path.join(this.paths.short(id), 'cover.jpg');
  }

  private thumbnailPath(id: string) {
    return path.join(this.paths.short(id), 'thumbnail.jpg');
  }

  /** The tags given, cleaned to YouTube's rules — or, when there are none, suggested ones. */
  private tagsFor(tags: string[] | undefined, o: { title: string; hashtags: string[]; language: LanguageCode; book?: Book }): string[] {
    const clean = fitTags(tags ?? []);
    if (clean.length) return clean;
    return suggestShortTags({ title: o.title, hashtags: o.hashtags, language: o.language, bookTitle: o.book?.name, author: o.book?.document.author ?? undefined });
  }

  // ── write ────────────────────────────────────────────────
  async create(body: unknown): Promise<ShortDetail> {
    const parsed = shortInputSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid short: ${issues(parsed.error)}`);
    const input = parsed.data;
    const settings = this.parseSettings(input.settings);
    const book = input.projectId ? await this.projects.get(input.projectId) : undefined;
    const title = input.title.trim() || 'Untitled short';
    const hashtags = input.hashtags ?? [];
    const s = await this.prisma.short.create({
      data: {
        title,
        script: input.script.trim(),
        description: input.description?.trim() ?? '',
        hashtags,
        tags: this.tagsFor(input.tags, { title, hashtags, language: settings.language, book }),
        ...(input.thumbnail && { thumbnail: input.thumbnail as unknown as Prisma.InputJsonValue }),
        settings: settings as unknown as Prisma.InputJsonValue,
        projectId: input.projectId ?? null,
      },
    });
    await this.ensureCover(s.id, settings, s.projectId);
    if (input.render) await this.render(s.id);
    return this.detail(s.id);
  }

  async update(id: string, body: unknown): Promise<ShortDetail> {
    const s = await this.get(id);
    const parsed = shortUpdateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid short: ${issues(parsed.error)}`);
    const input = parsed.data;
    // The YouTube text and the thumbnail can be edited while the video renders; the rest cannot.
    const video = Object.keys(input).some((k) => !METADATA_FIELDS.includes(k));
    if (video && this.busy(s)) throw conflict('Wait until the short has finished rendering, or cancel it.');
    const settings = video ? this.parseSettings(input.settings ?? {}, this.resolve(s.settings)) : this.resolve(s.settings);
    if (input.projectId && input.projectId !== s.projectId) await this.projects.get(input.projectId);
    const projectId = input.projectId === undefined ? s.projectId : input.projectId;
    if (projectId !== s.projectId) await fsp.rm(this.coverPath(id), { force: true }); // another book, another cover
    const title = input.title !== undefined ? input.title.trim() || 'Untitled short' : s.title;
    const hashtags = input.hashtags ?? s.hashtags;
    const data: Prisma.ShortUncheckedUpdateInput = {};
    if (video) Object.assign(data, { title, settings: settings as unknown as Prisma.InputJsonValue, projectId, ...(input.script !== undefined && { script: input.script.trim() }) });
    if (input.description !== undefined) data.description = input.description.trim();
    if (input.hashtags !== undefined) data.hashtags = input.hashtags;
    if (input.thumbnail !== undefined) data.thumbnail = input.thumbnail === null ? Prisma.DbNull : (input.thumbnail as unknown as Prisma.InputJsonValue);
    if (input.tags !== undefined || !s.tags.length) {
      const book = projectId ? await this.projects.get(projectId).catch(() => undefined) : undefined;
      data.tags = this.tagsFor(input.tags, { title, hashtags, language: settings.language, book });
    }
    await this.prisma.short.update({ where: { id }, data });
    if (video) await this.ensureCover(id, settings, projectId);
    if (input.render) await this.render(id);
    return this.detail(id);
  }

  /** Store the thumbnail JPEG the browser drew (≤ 2 MB, checked by the controller). */
  async saveThumbnail(id: string, jpeg: Buffer): Promise<ShortDetail> {
    await this.get(id);
    if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw badRequest('The thumbnail must be a JPEG image.');
    await ensureDir(this.paths.short(id));
    await atomicWrite(this.thumbnailPath(id), jpeg);
    return this.detail(id);
  }

  async deleteThumbnail(id: string): Promise<ShortDetail> {
    await this.get(id);
    await fsp.rm(this.thumbnailPath(id), { force: true });
    await this.prisma.short.update({ where: { id }, data: { thumbnail: Prisma.DbNull } });
    return this.detail(id);
  }

  private busy(s: Short) {
    return SHORT_ACTIVE.includes(s.status) || (s.status === 'PENDING' && !!(s.snapshot as ShortSnapshot | null)?.queued);
  }

  /** Queue a render. The narration is reused when only the look changed. */
  async render(id: string): Promise<{ jobId: string }> {
    const s = await this.get(id);
    if (this.busy(s)) throw conflict('This short is already rendering.');
    if (!s.script.trim()) throw badRequest('Write or generate a script first.');
    const settings = this.resolve(s.settings);
    const est = estimateShortSec(s.script, settings.language, settings.tts.speed);
    if (est > SHORT_MAX_SEC * 1.15)
      throw badRequest(`This script takes about ${formatDuration(est)} to read — a YouTube Short can be at most 3 minutes.`, 'Shorten the script, or make the voice a little faster.');
    await this.ensureCover(id, settings, s.projectId);
    const claim = await this.prisma.short.updateMany({
      where: { id, status: { notIn: SHORT_ACTIVE } },
      data: { status: 'PENDING', progress: 0, cancelRequested: false, snapshot: { queued: true, message: 'Waiting for the worker…' } satisfies ShortSnapshot },
    });
    if (!claim.count) throw conflict('This short is already rendering.');
    try {
      return { jobId: await this.queue.enqueueShort(id) };
    } catch (e) {
      const error = (e as AppError).toUser?.() ?? { code: 'INTERNAL', message: 'The short could not be queued.', retryable: true };
      await this.prisma.short.update({ where: { id }, data: { status: 'FAILED', snapshot: { message: error.message, error } as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
      throw e;
    }
  }

  async cancel(id: string): Promise<{ ok: boolean }> {
    const s = await this.get(id);
    // Still queued: the worker only starts PENDING shorts, so this wins over a later start.
    const queued = await this.prisma.short.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED', snapshot: { message: 'Cancelled.' } } });
    if (!queued.count && SHORT_ACTIVE.includes(s.status)) await this.prisma.short.update({ where: { id }, data: { cancelRequested: true } });
    return { ok: true };
  }

  async remove(id: string): Promise<{ ok: boolean }> {
    const s = await this.get(id);
    if (SHORT_ACTIVE.includes(s.status)) throw conflict('Cancel the render before deleting the short.');
    await this.prisma.short.delete({ where: { id } });
    await rmrf(this.paths.short(id));
    return { ok: true };
  }

  /** The cover background: the book's first page, copied so the short keeps it if the book is deleted. */
  private async ensureCover(id: string, settings: ShortSettings, projectId: string | null) {
    if (settings.look.theme !== 'cover' || !projectId) return;
    const dest = this.coverPath(id);
    if (await exists(dest)) return;
    try {
      const page = await this.projects.pageImage(projectId, 1);
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(page, dest);
    } catch (e) {
      this.log.warn(`No cover for short ${id}: ${(e as Error).message}`); // the renderer falls back to a gradient
    }
  }

  // ── local AI ─────────────────────────────────────────────
  private provider() {
    return new OllamaProvider({ baseUrl: this.cfg.OLLAMA_BASE_URL, model: this.cfg.OLLAMA_MODEL, timeoutMs: Math.max(this.cfg.LLM_TIMEOUT_MS, 180_000) });
  }

  /** The local model, or a clear error when it is turned off or not running. */
  private async readyProvider(what: string): Promise<OllamaProvider> {
    if (!this.cfg.LLM_ENABLED) throw conflict(`The local AI is turned off. Set LLM_ENABLED=true in .env and restart the API — or write the ${what} yourself.`);
    const provider = this.provider();
    const st = await provider.isAvailable();
    if (!st.ok) throw new AppError('OLLAMA_UNAVAILABLE', st.message, { hint: `Start Ollama (ollama serve) and try again — or write the ${what} yourself.` });
    return provider;
  }

  /** Write a script with the local AI. Nothing is saved; closing the request stops the model. */
  async generateScript(body: unknown, signal?: AbortSignal): Promise<ShortScriptResult> {
    const parsed = scriptRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid request: ${issues(parsed.error)}`);
    const req = parsed.data;
    const provider = await this.readyProvider('script');
    let src: ShortScriptSource;
    if (req.source.kind === 'topic') src = { kind: 'topic', topic: req.source.topic.trim() };
    else {
      const p = await this.projects.get(req.source.projectId);
      src = { kind: 'book', title: p.name, author: p.document.author ?? undefined, excerpt: await this.bookExcerpt(p.id, req.language) };
    }
    const draft = await generateShortScript(provider, src, { language: req.language, seconds: req.seconds, style: req.style }, signal);
    return { ...draft, model: provider.model };
  }

  /** YouTube description, hashtags and tags for a script written by hand. Nothing is saved. */
  async generateMetadata(body: unknown, signal?: AbortSignal): Promise<ShortMetadataResult> {
    const parsed = metadataSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid request: ${issues(parsed.error)}`);
    const req = parsed.data;
    const provider = await this.readyProvider('description and tags');
    const book = req.projectId ? await this.projects.get(req.projectId) : undefined;
    const r = await generateShortMetadata(provider, { title: req.title, script: req.script, language: req.language, bookTitle: book?.name, author: book?.document.author ?? undefined }, signal);
    return { ...r, model: provider.model };
  }

  /** The opening of the book's first real chapter (front matter skipped), from its analysed sentences. */
  async bookExcerpt(projectId: string, language: LanguageCode): Promise<string> {
    const rows = await this.prisma.sentence.findMany({
      where: { paragraph: { chapter: { projectId } } },
      select: { text: true, paragraph: { select: { chapter: { select: { title: true } } } } },
      orderBy: [{ paragraph: { chapter: { index: 'asc' } } }, { paragraph: { index: 'asc' } }, { index: 'asc' }],
      take: 600,
    });
    const max = language === 'bn' ? 2500 : 3500; // Bangla needs more tokens per character
    let out = '';
    for (const r of rows) {
      if (isFrontMatterTitle(r.paragraph.chapter.title)) continue;
      if (out.length + r.text.length + 1 > max) break;
      out += (out ? ' ' : '') + r.text;
    }
    return out;
  }
}

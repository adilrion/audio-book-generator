import fsp from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CachePaths, OllamaProvider, generatePublishDraft, readMediaTags, templateDraft, writeMediaTags } from '@app/pipeline';
import { AppError, atomicWrite, atomicWriteJson, hashKey, readJsonIfExists } from '@app/shared';
import {
  type AppliedFile,
  type DeepPartial,
  type EmbeddedTags,
  type GeneratePublishRequest,
  type ProjectSettings,
  type PublishContext,
  type PublishDraft,
  type PublishState,
  type Timeline,
  YOUTUBE_LIMITS,
  fileTagsFor,
  resolveSettings,
} from '@app/types';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest, conflict } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE, ProjectsService } from '../projects/projects.service';
import { generateSchema, issues, saveSchema } from './publish.schema';

/** storage/output/<id>/publish.json */
interface PublishFile {
  draft: PublishDraft;
  applied?: { at: string; draftHash: string; cover: boolean; files: AppliedFile[] };
}

const MEDIA: [name: string, kind: 'video' | 'audio'][] = [
  ['audiobook.mp4', 'video'],
  ['audiobook.m4a', 'audio'],
];

/**
 * The Publish tab: a metadata draft per project (YouTube, social posts, file tags), AI generation
 * with the local model, the thumbnail, and writing the tags into the finished files.
 */
@Injectable()
export class PublishService {
  private readonly paths: CachePaths;
  private readonly log = new Logger('Publish');
  /** One generate / apply at a time per project. */
  private readonly busy = new Map<string, 'generate' | 'apply'>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {
    this.paths = new CachePaths(cfg);
  }

  // ── read ─────────────────────────────────────────────────
  private async load(id: string): Promise<PublishFile | undefined> {
    return readJsonIfExists<PublishFile>(this.paths.publish(id)).catch(() => undefined);
  }

  private async store(id: string, file: PublishFile): Promise<void> {
    await fsp.mkdir(this.paths.output(id), { recursive: true });
    await atomicWriteJson(this.paths.publish(id), file, true);
  }

  private async timeline(id: string): Promise<Timeline | undefined> {
    return readJsonIfExists<Timeline>(path.join(this.paths.output(id), 'timeline.json')).catch(() => undefined);
  }

  async context(id: string, timeline?: Timeline): Promise<PublishContext> {
    const p = await this.projects.get(id);
    const settings = resolveSettings(p.settings as DeepPartial<ProjectSettings>);
    const tl = timeline ?? (await this.timeline(id));
    const outputs = await this.projects.outputs(id);
    return {
      title: p.name,
      author: p.document.author?.trim() || undefined,
      language: settings.language,
      durationSec: tl?.duration ?? p.durationSec ?? 0,
      pageCount: p.document.pageCount,
      wordCount: p.document.estimatedWords,
      chapters: (tl?.chapters ?? []).map((c) => ({ title: c.title, start: c.start, end: c.end })),
      aspectRatio: settings.video.aspectRatio,
      hasVideo: outputs.some((o) => o.name === 'audiobook.mp4'),
      hasAudio: outputs.some((o) => o.name === 'audiobook.m4a'),
    };
  }

  private async thumbStat(id: string) {
    return fsp.stat(this.paths.thumbnail(id)).catch(() => null);
  }

  /** Fingerprint of everything "Apply" writes, to tell when the files fall behind the draft. */
  private async applyHash(id: string, draft: PublishDraft, ctx: PublishContext): Promise<string> {
    const thumb = await this.thumbStat(id);
    return hashKey(fileTagsFor(draft, ctx, 'video'), fileTagsFor(draft, ctx, 'audio'), draft.file.embedCover, draft.youtube.language, thumb?.mtimeMs ?? null);
  }

  private async llmStatus(): Promise<PublishState['llm']> {
    const model = this.cfg.OLLAMA_MODEL;
    if (!this.cfg.LLM_ENABLED) return { enabled: false, available: false, model, message: 'The local AI is turned off (LLM_ENABLED=false in .env).' };
    const st = await this.provider().isAvailable();
    return { enabled: true, available: st.ok, model, message: st.message };
  }

  private provider() {
    // A new provider per call: its availability check is cached, and Ollama may be started later.
    return new OllamaProvider({ baseUrl: this.cfg.OLLAMA_BASE_URL, model: this.cfg.OLLAMA_MODEL, timeoutMs: Math.max(this.cfg.LLM_TIMEOUT_MS, 180_000) });
  }

  async state(id: string): Promise<PublishState> {
    const ctx = await this.context(id);
    const file = await this.load(id);
    const draft = file?.draft ?? templateDraft(ctx);
    const thumb = await this.thumbStat(id);
    const embedded: EmbeddedTags[] = [];
    for (const [name] of MEDIA) {
      const f = path.join(this.paths.output(id), name);
      if (!(await fsp.stat(f).catch(() => null))) continue;
      try {
        const t = await readMediaTags(this.cfg, f);
        embedded.push({ name, size: t.size, tags: t.tags, hasCover: t.hasCover, chapters: t.chapters });
      } catch (e) {
        this.log.warn(`Could not read the tags of ${name}: ${(e as Error).message}`);
      }
    }
    let applied: PublishState['applied'];
    if (file?.applied) {
      const stale: ('files' | 'draft')[] = [];
      for (const a of file.applied.files) {
        const st = await fsp.stat(path.join(this.paths.output(id), a.name)).catch(() => null);
        if (!st || st.size !== a.size || Math.round(st.mtimeMs) !== Math.round(a.mtimeMs)) stale.push('files');
      }
      if ((await this.applyHash(id, draft, ctx)) !== file.applied.draftHash) stale.push('draft');
      applied = { at: file.applied.at, cover: file.applied.cover, files: file.applied.files.map((f) => f.name), stale: [...new Set(stale)] };
    }
    return {
      draft,
      saved: !!file,
      context: ctx,
      thumbnail: thumb ? { url: `/projects/${id}/output/thumbnail.jpg`, size: thumb.size, updatedAt: thumb.mtime.toISOString() } : undefined,
      applied,
      embedded,
      llm: await this.llmStatus(),
    };
  }

  // ── write ────────────────────────────────────────────────
  async save(id: string, body: unknown): Promise<PublishState> {
    await this.projects.get(id);
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid publishing metadata: ${issues(parsed.error)}`);
    const file = await this.load(id);
    await this.store(id, { ...file, draft: { ...(parsed.data.draft as PublishDraft), updatedAt: new Date().toISOString() } });
    return this.state(id);
  }

  /** Write YouTube and/or social metadata with the local AI, merged into the editor's draft. */
  async generate(id: string, body: unknown, signal?: AbortSignal): Promise<PublishState> {
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid request: ${issues(parsed.error)}`);
    const req = parsed.data as GeneratePublishRequest;
    if (!this.cfg.LLM_ENABLED) throw conflict('The local AI is turned off. Set LLM_ENABLED=true in .env and restart the API.');
    const provider = this.provider();
    const st = await provider.isAvailable();
    if (!st.ok) throw new AppError('OLLAMA_UNAVAILABLE', st.message, { hint: 'The rule-based metadata is still available — edit it by hand, or start Ollama and try again.' });

    const tl = await this.timeline(id);
    const ctx = await this.context(id, tl);
    if (!ctx.hasVideo && !ctx.hasAudio) throw conflict('Publishing metadata is written once the audiobook is ready.');
    return this.exclusive(id, 'generate', async () => {
      const file = await this.load(id);
      const draft = req.draft ?? file?.draft ?? templateDraft(ctx);
      const opts = { ...draft.ai, ...req.options };
      const next = await generatePublishDraft(provider, { ctx, excerpt: excerptOf(tl, ctx.language) }, draft, req.sections, opts, signal);
      await this.store(id, { ...file, draft: { ...next, updatedAt: new Date().toISOString() } });
      return this.state(id);
    });
  }

  /** Embed the draft's file tags (+ cover art) into audiobook.mp4 / audiobook.m4a, stream-copied. */
  async apply(id: string): Promise<PublishState> {
    const p = await this.projects.get(id);
    if (ACTIVE.includes(p.status)) throw conflict('Wait until processing has finished — the files are being rewritten.');
    const queued = await this.prisma.renderJob.count({ where: { projectId: id, status: { in: ['PENDING', ...ACTIVE] } } });
    if (queued) throw conflict('This project is queued for processing — apply the metadata once it has finished.');

    return this.exclusive(id, 'apply', async () => {
      const ctx = await this.context(id);
      const file = await this.load(id);
      const draft = file?.draft ?? templateDraft(ctx);
      const thumb = (await this.thumbStat(id)) ? this.paths.thumbnail(id) : undefined;
      let page: string | undefined;
      if (draft.file.embedCover) {
        try {
          page = await this.projects.pageImage(id, 1);
        } catch (e) {
          this.log.warn(`No book cover for ${id}: ${(e as Error).message}`);
        }
      }
      const done: AppliedFile[] = [];
      for (const [name, kind] of MEDIA) {
        const f = path.join(this.paths.output(id), name);
        if (!(await fsp.stat(f).catch(() => null))) continue;
        // The video gets the YouTube thumbnail; the audiobook the book's cover (players show it square-ish).
        const cover = draft.file.embedCover ? (kind === 'video' ? (thumb ?? page) : (page ?? thumb)) : undefined;
        await writeMediaTags(this.cfg, { file: f, kind, tags: fileTagsFor(draft, ctx, kind), cover, language: draft.youtube.language });
        const st = await fsp.stat(f);
        done.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      }
      if (!done.length) throw conflict('There are no finished files to write the metadata into yet.');
      await this.store(id, { draft, applied: { at: new Date().toISOString(), draftHash: await this.applyHash(id, draft, ctx), cover: draft.file.embedCover, files: done } });
      return this.state(id);
    });
  }

  /** Save a 1280×720 JPEG made in the browser (or uploaded) as the thumbnail. */
  async saveThumbnail(id: string, data: Buffer): Promise<PublishState> {
    await this.projects.get(id);
    if (data.length > YOUTUBE_LIMITS.thumbnailBytes) throw badRequest('The thumbnail must be 2 MB or smaller (YouTube’s limit).');
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw badRequest('The thumbnail must be a JPEG image.');
    await fsp.mkdir(this.paths.output(id), { recursive: true });
    await atomicWrite(this.paths.thumbnail(id), data);
    return this.state(id);
  }

  async deleteThumbnail(id: string): Promise<PublishState> {
    await this.projects.get(id);
    await fsp.rm(this.paths.thumbnail(id), { force: true });
    return this.state(id);
  }

  private async exclusive<T>(id: string, what: 'generate' | 'apply', fn: () => Promise<T>): Promise<T> {
    const running = this.busy.get(id);
    if (running) throw conflict(running === 'generate' ? 'The AI is already writing metadata for this project.' : 'The metadata is already being written into the files.');
    this.busy.set(id, what);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }
}

/** The book's opening as narrated (front matter the run skipped is not in the timeline). */
export function excerptOf(tl: Timeline | undefined, language: 'en' | 'bn'): string {
  if (!tl) return '';
  const max = language === 'bn' ? 2500 : 3500; // Bangla needs more tokens per character
  let out = '';
  for (const s of tl.segments) {
    if (out.length + s.text.length + 1 > max) break;
    out += (out ? ' ' : '') + s.text;
  }
  return out;
}

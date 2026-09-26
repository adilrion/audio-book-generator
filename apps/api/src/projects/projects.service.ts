import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type Document, type JobStatus, type Project } from '@prisma/client';
import { CachePaths, cleanProjectCache, deleteProjectFiles, type OutputRecord, type ProjectManifest } from '@app/pipeline';
import { AppError, exists, readJsonIfExists, sha256File, toAppError } from '@app/shared';
import {
  ASPECT_SIZES,
  resolveSettings,
  type DeepPartial,
  type OutputFile,
  type PdfInspection,
  type ProgressSnapshot,
  type ProjectDetail,
  type ProjectSettings,
  type ProjectSummary,
  type StepRecord,
} from '@app/types';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { PythonService } from '../system/python.service';
import { settingsSchema } from './settings.schema';

const ACTIVE: JobStatus[] = ['EXTRACTING', 'CLEANING', 'ANALYZING', 'GENERATING_AUDIO', 'PREPARING_VIDEO', 'RENDERING'];
/** Project ids are UUIDs; anything with dots or slashes (e.g. "..%2F..") must never reach a file path. */
const SAFE_ID = /^[a-z0-9-]+$/i;
type ProjectWithDoc = Project & { document: Document };

@Injectable()
export class ProjectsService {
  private readonly paths: CachePaths;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly python: PythonService,
  ) {
    this.paths = new CachePaths(cfg);
  }

  // ── create ───────────────────────────────────────────────
  async create(file: Express.Multer.File, rawSettings?: string, name?: string): Promise<ProjectDetail> {
    if (!file) throw badRequest('Please choose a PDF file to upload.');
    let hash = '';
    let moved: string | undefined; // PDF this request moved into storage/uploads, until a Document owns it
    try {
      const fd = await fsp.open(file.path, 'r');
      const head = Buffer.alloc(5);
      await fd.read(head, 0, 5, 0);
      await fd.close();
      if (head.toString('latin1') !== '%PDF-') throw badRequest('This file is not a PDF.', 'Choose a .pdf file.');
      const settings = this.parseSettings(rawSettings); // validate before touching storage

      hash = await sha256File(file.path);
      const dest = this.paths.upload(hash);
      if (await exists(dest)) await fsp.rm(file.path, { force: true });
      else {
        await fsp.rename(file.path, dest);
        moved = dest;
      }

      let info: PdfInspection;
      try {
        info = await this.python.call<PdfInspection>('pdf.inspect', { path: dest });
      } catch (e) {
        throw toAppError(e);
      }
      if (info.likelyScanned && settings.text.ocr === 'off')
        throw badRequest('This PDF is a scan (images only). Enable OCR to process it.');

      const doc = await this.prisma.document.upsert({
        where: { hash },
        create: {
          hash,
          fileName: file.originalname,
          filePath: dest,
          fileSize: BigInt(info.fileSize),
          pageCount: info.pageCount,
          estimatedWords: info.estimatedWords,
          title: info.title,
          author: info.author,
          likelyScanned: info.likelyScanned,
          hasToc: info.hasToc,
          encrypted: info.encrypted,
        },
        update: { fileName: file.originalname, filePath: dest },
      });
      moved = undefined;
      const projectName = (name?.trim() || info.title || file.originalname.replace(/\.pdf$/i, '')).slice(0, 200);
      const project = await this.prisma.project.create({
        data: { name: projectName, documentId: doc.id, settings: settings as unknown as Prisma.InputJsonValue },
        include: { document: true },
      });
      return this.detail(project.id);
    } catch (e) {
      if (moved) await this.discardUpload(moved, hash);
      throw e;
    } finally {
      await fsp.rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  /** A rejected upload (password, corrupt, scan without OCR…) must not leave an orphaned PDF in storage. */
  private async discardUpload(file: string, hash: string) {
    // Keep it if a Document owns it (e.g. a concurrent upload of the same file) or the DB can't tell us.
    const owner = await this.prisma.document.findUnique({ where: { hash }, select: { id: true } }).catch(() => ({ id: '?' }));
    if (!owner) await fsp.rm(file, { force: true }).catch(() => undefined);
  }

  private parseSettings(raw?: string | object, base?: ProjectSettings): ProjectSettings {
    let input: unknown = raw ?? {};
    if (typeof raw === 'string') {
      try {
        input = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        throw badRequest('Settings are not valid JSON.');
      }
    }
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw badRequest(`Invalid settings: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const p = parsed.data as DeepPartial<ProjectSettings> & { text?: { chapterRange?: unknown } };
    if (p.text && p.text.chapterRange === null) {
      delete (p.text as { chapterRange?: unknown }).chapterRange;
      if (base) base = { ...base, text: { ...base.text, chapterRange: undefined } };
    }
    if (p.video?.aspectRatio && !p.video.width) Object.assign(p.video, ASPECT_SIZES[p.video.aspectRatio]);
    const merged = resolveSettings(p, base);
    if (merged.language === 'bn' && merged.tts.engine === 'kokoro')
      throw badRequest('Bangla narration needs a Bangla-capable TTS voice, which is not installed yet.', 'See README → "How to add another TTS model".');
    return merged;
  }

  // ── read ─────────────────────────────────────────────────
  async list(): Promise<ProjectSummary[]> {
    const rows = await this.prisma.project.findMany({ include: { document: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((p) => this.summary(p));
  }

  private summary(p: ProjectWithDoc): ProjectSummary {
    return {
      id: p.id,
      name: p.name,
      fileName: p.document.fileName,
      status: p.status,
      progress: p.progress,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      pageCount: p.document.pageCount,
      wordCount: p.document.estimatedWords,
      durationSec: p.durationSec ?? undefined,
    };
  }

  async get(id: string): Promise<ProjectWithDoc> {
    const p = await this.prisma.project.findUnique({ where: { id }, include: { document: true } });
    if (!p) throw notFound('Project');
    return p;
  }

  snapshot(p: Project): ProgressSnapshot {
    return (p.snapshot as unknown as ProgressSnapshot) ?? { status: p.status, progress: p.progress, updatedAt: p.updatedAt.toISOString() };
  }

  async detail(id: string): Promise<ProjectDetail> {
    const p = await this.get(id);
    const [steps, chapters, audio] = await Promise.all([
      this.steps(id),
      this.prisma.chapter.findMany({ where: { projectId: id }, orderBy: { index: 'asc' } }),
      this.prisma.audioChunk.findMany({ where: { projectId: id } }),
    ]);
    const dur = new Map(audio.map((a) => [a.chapterIndex, a.durationSec]));
    const d = p.document;
    return {
      ...this.summary(p),
      settings: resolveSettings(p.settings as DeepPartial<ProjectSettings>),
      document: {
        hash: d.hash,
        fileName: d.fileName,
        pageCount: d.pageCount,
        encrypted: d.encrypted,
        needsPassword: false,
        title: d.title ?? undefined,
        author: d.author ?? undefined,
        estimatedWords: d.estimatedWords,
        likelyScanned: d.likelyScanned,
        hasToc: d.hasToc,
        fileSize: Number(d.fileSize),
      },
      snapshot: this.snapshot(p),
      steps,
      outputs: await this.outputs(id),
      chapters: chapters.map((c) => ({ index: c.index, title: c.title, pageStart: c.pageStart, pageEnd: c.pageEnd, durationSec: dur.get(c.index) })),
    };
  }

  async steps(id: string): Promise<StepRecord[]> {
    const rows = await this.prisma.processingStep.findMany({ where: { projectId: id }, orderBy: [{ order: 'asc' }, { key: 'asc' }] });
    return rows.map((r) => ({
      key: r.key,
      stage: r.stage as StepRecord['stage'],
      status: r.status,
      progress: r.progress,
      cached: r.cached,
      chapterIndex: r.chapterIndex ?? undefined,
      message: r.message ?? undefined,
      error: (r.error as unknown as StepRecord['error']) ?? undefined,
      startedAt: r.startedAt?.toISOString(),
      finishedAt: r.finishedAt?.toISOString(),
    }));
  }

  async status(id: string) {
    const p = await this.get(id);
    const s = this.snapshot(p);
    return { ...s, status: p.status, progress: p.progress };
  }

  private outputDir(id: string, what = 'File'): string {
    if (!SAFE_ID.test(id)) throw notFound(what);
    return this.paths.output(id);
  }

  async outputs(id: string): Promise<OutputFile[]> {
    const dir = this.outputDir(id, 'Project');
    const out: OutputFile[] = [];
    const known: [string, OutputFile['kind']][] = [
      ['audiobook.mp4', 'video'],
      ['audiobook.m4a', 'audio'],
      ['subtitles.srt', 'subtitles'],
      ['chapters.txt', 'timeline'],
    ];
    for (const [name, kind] of known) {
      const st = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (st?.isFile()) out.push({ name, kind, size: st.size, url: `/projects/${id}/output/${name}` });
    }
    return out;
  }

  outputPath(id: string, name: string): string {
    if (!/^[a-z0-9._-]+$/i.test(name) || name.startsWith('.')) throw notFound('File');
    return path.join(this.outputDir(id), name);
  }

  async timelinePath(id: string): Promise<string> {
    await this.get(id);
    const f = path.join(this.paths.output(id), 'timeline.json');
    if (!(await exists(f))) throw new AppError('NOT_READY', 'The timeline is not ready yet — it is created after audio generation.', { retryable: false });
    return f;
  }

  async pageImage(id: string, page: number): Promise<string> {
    const p = await this.get(id);
    if (!Number.isInteger(page) || page < 1 || page > p.document.pageCount) throw notFound('Page');
    const out = this.paths.preview(p.document.hash, page);
    if (!(await exists(out))) await this.python.call('pdf.render_preview', { path: p.document.filePath, page, scale: 1.6, outPath: out });
    return out;
  }

  // ── actions ──────────────────────────────────────────────
  async updateSettings(id: string, raw: unknown): Promise<ProjectDetail> {
    const p = await this.get(id);
    if (ACTIVE.includes(p.status)) throw conflict('Settings cannot be changed while the project is processing.');
    const merged = this.parseSettings(raw as object, resolveSettings(p.settings as DeepPartial<ProjectSettings>));
    await this.prisma.project.update({ where: { id }, data: { settings: merged as unknown as Prisma.InputJsonValue } });
    return this.detail(id);
  }

  /** Start / resume / retry. Finished steps are reused from cache automatically. */
  async process(id: string, force = false): Promise<{ jobId: string }> {
    const p = await this.get(id);
    if (!fs.existsSync(p.document.filePath)) throw new AppError('PDF_MISSING', 'The uploaded PDF file is missing from storage. Please upload it again.', { retryable: false });
    // Check-and-queue under a row lock: a double click must not start two runs, and the worker may
    // already have taken the job (render job EXTRACTING) while the project row still says PENDING.
    const rj = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${id} FOR UPDATE`;
      const cur = await tx.project.findUnique({ where: { id }, select: { status: true, progress: true } });
      if (!cur) throw notFound('Project');
      if (ACTIVE.includes(cur.status)) throw conflict('This project is already processing.');
      const open = await tx.renderJob.findFirst({ where: { projectId: id, status: { in: ['PENDING', ...ACTIVE] } } });
      if (open) throw conflict(open.status === 'PENDING' ? 'This project is already queued.' : 'This project is already processing.');
      const job = await tx.renderJob.create({ data: { projectId: id, force } });
      // Written before the job is visible to the worker, so it can never overwrite the worker's progress.
      await tx.project.update({
        where: { id },
        data: {
          status: 'PENDING',
          cancelRequested: false,
          snapshot: { status: 'PENDING', progress: cur.progress, message: 'Waiting for the worker…', updatedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
      return job;
    });
    let jobId: string;
    try {
      if (force) {
        await this.prisma.processingStep.deleteMany({ where: { projectId: id } });
        await rmOutputsKeepNothing(this.paths.output(id));
      }
      jobId = await this.queue.enqueue({ projectId: id, renderJobId: rj.id, force });
    } catch (e) {
      // Nothing was queued: drop the render job and restore the previous state (e.g. FAILED and its error).
      await this.prisma.renderJob.delete({ where: { id: rj.id } }).catch(() => undefined);
      await this.prisma.project
        .update({ where: { id }, data: { status: p.status, snapshot: p.snapshot === null ? Prisma.DbNull : (p.snapshot as Prisma.InputJsonValue) } })
        .catch(() => undefined);
      throw e;
    }
    await this.prisma.renderJob.update({ where: { id: rj.id }, data: { queueJobId: jobId } }).catch(() => undefined);
    return { jobId };
  }

  async cancel(id: string) {
    const p = await this.get(id);
    // Still queued: cancel the run itself. Conditional, so it is atomic with the worker claiming the
    // run (PENDING → EXTRACTING): whichever lands first wins and a cancelled run is never started.
    const queued = await this.prisma.renderJob.updateMany({ where: { projectId: id, status: 'PENDING' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    if (queued.count > 0) {
      const snapshot = { ...((p.snapshot as object) ?? {}), status: 'CANCELLED', message: 'Processing was cancelled.', updatedAt: new Date().toISOString() };
      await this.prisma.project.update({ where: { id }, data: { cancelRequested: true, status: 'CANCELLED', snapshot: snapshot as Prisma.InputJsonValue } });
    } else {
      // Running (or claimed but not reported yet): the worker polls this flag and stops within ~2 s.
      await this.prisma.project.update({ where: { id }, data: { cancelRequested: true } });
    }
    return { ok: true };
  }

  async cleanCache(id: string) {
    const p = await this.get(id);
    if (ACTIVE.includes(p.status)) throw conflict('Stop processing before cleaning the cache.');
    // Extraction, page renders and (same voice) chapter audio are shared by every project made from this PDF.
    const busy = await this.prisma.project.count({ where: { documentId: p.documentId, NOT: { id }, status: { in: ACTIVE } } });
    if (busy) throw conflict('Another project made from this PDF is processing and uses the same cache. Try again when it has finished.');
    const freedBytes = await cleanProjectCache(this.cfg, id, p.document.hash);
    await this.prisma.processingStep.deleteMany({ where: { projectId: id } });
    await this.prisma.project.update({ where: { id }, data: { analysisKey: null } });
    return { freedBytes };
  }

  async remove(id: string, deleteOutputs: boolean) {
    const p = await this.get(id);
    if (ACTIVE.includes(p.status)) throw conflict('Stop processing before deleting the project.');
    const siblings = await this.prisma.project.findMany({ where: { documentId: p.documentId, NOT: { id } }, select: { id: true } });
    if (siblings.length === 0) await deleteProjectFiles(this.cfg, id, p.document.hash, { deleteOutputs, deleteUpload: true });
    else await this.deleteUnsharedFiles(id, deleteOutputs);
    await this.prisma.project.delete({ where: { id } });
    if (siblings.length === 0) await this.prisma.document.delete({ where: { id: p.documentId } }).catch(() => undefined);
    return { ok: true, outputsKept: !deleteOutputs };
  }

  /**
   * Other projects still use this PDF (the DB knows, even before they wrote a manifest): keep its
   * hash-keyed caches (extraction, page renders, previews) and any chapter audio / video segment
   * another project's manifest references. Only files that belong to this project alone go.
   */
  private async deleteUnsharedFiles(id: string, deleteOutputs: boolean) {
    const read = (pid: string) => readJsonIfExists<ProjectManifest>(path.join(this.paths.output(pid), 'manifest.json')).catch(() => undefined);
    const mine = await read(id);
    const shared = new Set<string>();
    for (const other of await fsp.readdir(this.cfg.storage.output).catch(() => [] as string[])) {
      if (other === id) continue;
      const m = await read(other);
      for (const k of [...(m?.audioKeys ?? []), ...(m?.videoKeys ?? [])]) shared.add(k);
    }
    const targets: string[] = [this.paths.work(id)];
    for (const k of mine?.audioKeys ?? []) if (!shared.has(k)) targets.push(this.paths.chapterAudio(k).audio, this.paths.chapterAudio(k).meta);
    for (const k of mine?.videoKeys ?? []) if (!shared.has(k)) targets.push(this.paths.videoSegment(k));
    if (deleteOutputs) targets.push(this.paths.output(id));
    for (const t of targets) await fsp.rm(t, { recursive: true, force: true });
  }

  async manifest(id: string) {
    return readJsonIfExists<OutputRecord[]>(path.join(this.outputDir(id), 'manifest.json'));
  }
}

/** Restart: drop derived per-project files (timeline, manifest). Final outputs are overwritten on success. */
async function rmOutputsKeepNothing(dir: string) {
  for (const f of ['manifest.json', 'timeline.json']) await fsp.rm(path.join(dir, f), { force: true });
}

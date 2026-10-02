import fsp from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@app/shared';
import type { LibraryBookDetail, LibrarySearchResult, ProjectDetail } from '@app/types';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest } from '../common/errors';
import { incomingDir, incomingFileName } from '../projects/incoming';
import { ProjectsService } from '../projects/projects.service';
import { ARCHIVE_ID, ArchiveClient, archiveDownloadUrl, archiveIdFromUrl } from './archive';
import { directLink, downloadPdf, parseLink, tooLarge } from './download';

export const ARCHIVE_CLIENT = Symbol('ARCHIVE_CLIENT');

const searchSchema = z.object({
  q: z.string().max(200).default(''),
  language: z.enum(['any', 'en', 'bn']).default('any'),
  free: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  page: z.coerce.number().int().min(1).max(100).default(1),
});

const common = { settings: z.record(z.unknown()).optional(), name: z.string().max(200).optional() };
const importSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('archive'), id: z.string().regex(ARCHIVE_ID), file: z.string().min(1).max(500).optional(), ...common }),
  z.object({ source: z.literal('url'), url: z.string().min(1).max(4000), ...common }),
]);

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');

export type ImportProgress = { phase: 'downloading'; received: number; total?: number } | { phase: 'inspecting' };

/** "Pride and prejudice : a novel" → "Pride and prejudice" (archive.org titles carry the subtitle). */
const mainTitle = (t: string) => t.split(/\s+:\s+/)[0].trim().slice(0, 200) || t.slice(0, 200);

@Injectable()
export class LibraryService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly projects: ProjectsService,
    @Inject(ARCHIVE_CLIENT) private readonly archive: ArchiveClient,
  ) {}

  search(query: unknown, signal?: AbortSignal): Promise<LibrarySearchResult> {
    const parsed = searchSchema.safeParse(query ?? {});
    if (!parsed.success) throw badRequest(`Invalid search: ${issues(parsed.error)}`);
    const { q, language, free, page } = parsed.data;
    return this.archive.search({ q, language, freeOnly: free, page }, signal);
  }

  book(id: string, signal?: AbortSignal): Promise<LibraryBookDetail> {
    return this.archive.item(id, signal);
  }

  /**
   * Download a library book (or any PDF link) and create a project from it, exactly like an upload.
   * Settings are checked before the download starts; a request cancelled while the PDF was being
   * inspected leaves no project behind.
   */
  async import(body: unknown, opts: { signal?: AbortSignal; onProgress?: (p: ImportProgress) => void } = {}): Promise<ProjectDetail> {
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) throw badRequest(`Invalid import request: ${issues(parsed.error)}`);
    const req = parsed.data;
    this.projects.parseSettings(req.settings ?? {}); // throws before anything is downloaded
    const maxBytes = this.cfg.MAX_UPLOAD_MB * 1024 * 1024;
    const source = await this.resolve(req, maxBytes, opts.signal);

    const dir = incomingDir(this.cfg.storage.uploads);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, incomingFileName());
    const dl = await downloadPdf(source.link, tmp, {
      maxBytes,
      signal: opts.signal,
      onProgress: (received, total) => opts.onProgress?.({ phase: 'downloading', received, total: total ?? source.size }),
    });
    opts.onProgress?.({ phase: 'inspecting' });
    // create() moves the temp file into storage (or deletes it) whatever happens.
    const project = await this.projects.create({ path: tmp, originalname: source.fileName ?? dl.fileName }, req.settings, req.name?.trim() || source.name);
    if (opts.signal?.aborted) {
      await this.projects.remove(project.id, false).catch(() => undefined);
      throw new AppError('ABORTED', 'The download was cancelled.', { retryable: true });
    }
    return project;
  }

  /** Where to download from; archive.org book pages pasted as a link use the library route. */
  private async resolve(req: z.infer<typeof importSchema>, maxBytes: number, signal?: AbortSignal): Promise<{ link: URL; fileName?: string; name?: string; size?: number }> {
    let id: string | undefined;
    let wanted: string | undefined;
    if (req.source === 'archive') {
      id = req.id;
      wanted = req.file;
    } else {
      const url = parseLink(req.url);
      id = archiveIdFromUrl(url);
      if (!id) return { link: directLink(url) };
    }
    const book = await this.archive.item(id, signal);
    const file = wanted ? book.files.find((f) => f.name === wanted) : book.files[0];
    if (!file) {
      if (wanted) throw new AppError('NOT_FOUND', 'This book has no PDF with that name.', { hint: 'Open the book again and choose one of its PDFs.', retryable: false });
      throw badRequest('This book has no PDF that can be downloaded.', 'It may be a borrow-only book. Choose another edition.');
    }
    if (file.size > maxBytes) throw tooLarge(maxBytes);
    return { link: new URL(archiveDownloadUrl(id, file.name)), fileName: path.posix.basename(file.name), name: mainTitle(book.title), size: file.size || undefined };
  }
}

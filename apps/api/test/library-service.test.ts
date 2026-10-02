import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@app/config';
import type { LibraryBookDetail, ProjectDetail } from '@app/types';
import type { ArchiveClient } from '../src/library/archive';
import type { ImportProgress } from '../src/library/library.service';
import { LibraryService } from '../src/library/library.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ProjectsService } from '../src/projects/projects.service';
import type { QueueService } from '../src/queue/queue.service';
import type { PythonService } from '../src/system/python.service';

const downloads: { link: string; dest: string }[] = [];
vi.mock('../src/library/download', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/library/download')>();
  return {
    ...real,
    // The downloader has its own tests against a local server; here it just "downloads" a tiny PDF.
    downloadPdf: async (link: URL, dest: string, opts: { onProgress?: (r: number, t?: number) => void }) => {
      downloads.push({ link: link.toString(), dest });
      fs.writeFileSync(dest, '%PDF-1.7\n%%EOF\n');
      opts.onProgress?.(15);
      return { fileName: 'from-link.pdf', size: 15, url: link.toString() };
    },
  };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-library-'));
const cfg = loadConfig({ STORAGE_DIR: tmp, MAX_UPLOAD_MB: 1 }, { reload: true });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BOOK: LibraryBookDetail = {
  source: 'archive',
  id: 'prideprejudice00aust',
  title: 'Pride and prejudice : a novel',
  coverUrl: 'https://archive.org/services/img/prideprejudice00aust',
  pageUrl: 'https://archive.org/details/prideprejudice00aust',
  rights: 'public_domain',
  files: [
    { name: 'prideprejudice00aust.pdf', size: 1000, format: 'Text PDF' },
    { name: 'scans/volume 2.pdf', size: 2000, format: 'Text PDF' },
    { name: 'huge.pdf', size: 5 * 1024 * 1024, format: 'Text PDF' },
  ],
};

function setup(opts: { book?: Partial<LibraryBookDetail>; onCreate?: () => void } = {}) {
  const items: string[] = [];
  const archive = {
    item: async (id: string) => {
      items.push(id);
      return { ...BOOK, ...opts.book, id };
    },
    search: vi.fn(async () => ({ total: 0, page: 1, pageSize: 24, books: [] })),
  };
  const projects = new ProjectsService(cfg, {} as PrismaService, {} as QueueService, {} as PythonService);
  const created: { path: string; originalname: string; settings: unknown; name?: string; existed: boolean }[] = [];
  vi.spyOn(projects, 'create').mockImplementation(async (file, settings, name) => {
    created.push({ ...file, settings, name, existed: fs.existsSync(file.path) });
    fs.rmSync(file.path, { force: true });
    opts.onCreate?.();
    return { id: 'proj-1' } as ProjectDetail;
  });
  const remove = vi.spyOn(projects, 'remove').mockResolvedValue({ ok: true, outputsKept: true });
  const svc = new LibraryService(cfg, projects, archive as unknown as ArchiveClient);
  return { svc, items, created, remove, archive };
}

describe('LibraryService.import', () => {
  beforeEach(() => {
    downloads.length = 0;
  });

  it('downloads the best PDF of a library book into the upload temp folder and creates the project', async () => {
    const t = setup();
    const events: ImportProgress[] = [];
    const settings = { language: 'en', tts: { voice: 'af_sky' } };
    const p = await t.svc.import({ source: 'archive', id: 'prideprejudice00aust', settings }, { onProgress: (e) => events.push(e) });

    expect(p.id).toBe('proj-1');
    expect(downloads).toEqual([{ link: 'https://archive.org/download/prideprejudice00aust/prideprejudice00aust.pdf', dest: expect.stringContaining(path.join(cfg.storage.uploads, '.incoming')) }]);
    // The raw settings go to create(): its language → voice rules look at which keys were sent.
    expect(t.created).toEqual([{ path: downloads[0].dest, originalname: 'prideprejudice00aust.pdf', settings, name: 'Pride and prejudice', existed: true }]);
    expect(events).toEqual([{ phase: 'downloading', received: 15, total: 1000 }, { phase: 'inspecting' }]);
  });

  it('uses the chosen volume and a name the user typed', async () => {
    const t = setup();
    await t.svc.import({ source: 'archive', id: 'prideprejudice00aust', file: 'scans/volume 2.pdf', name: ' Volume Two ' });
    expect(downloads[0].link).toBe('https://archive.org/download/prideprejudice00aust/scans/volume%202.pdf');
    expect(t.created[0]).toMatchObject({ originalname: 'volume 2.pdf', name: 'Volume Two' });
  });

  it('refuses unknown volumes, books without PDFs and PDFs over the upload limit without downloading', async () => {
    await expect(setup().svc.import({ source: 'archive', id: 'x1', file: 'nope.pdf' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup({ book: { files: [] } }).svc.import({ source: 'archive', id: 'x2' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('no PDF') });
    await expect(setup().svc.import({ source: 'archive', id: 'x3', file: 'huge.pdf' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(downloads).toEqual([]);
  });

  it('checks the request and the settings before downloading anything', async () => {
    const t = setup();
    await expect(t.svc.import({ source: 'archive', id: 'ok', settings: { video: { fps: 500 } } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('settings') });
    await expect(t.svc.import({ source: 'archive', id: 'ok', settings: { language: 'bn', tts: { engine: 'kokoro' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Bangla') });
    await expect(t.svc.import({ source: 'archive', id: '../../etc' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(t.svc.import({ source: 'ftp' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(t.svc.import({ source: 'url', url: 'http://localhost:4000/projects' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('local network') });
    expect(t.items).toEqual([]);
    expect(downloads).toEqual([]);
  });

  it('downloads a pasted link (share links made direct) and names it from the PDF', async () => {
    const t = setup();
    await t.svc.import({ source: 'url', url: 'https://www.dropbox.com/s/abc/Book.pdf?dl=0' });
    expect(downloads[0].link).toBe('https://www.dropbox.com/s/abc/Book.pdf?dl=1');
    expect(t.created[0]).toMatchObject({ originalname: 'from-link.pdf', name: undefined });
    expect(t.items).toEqual([]);
  });

  it('treats a pasted archive.org book page as a library book', async () => {
    const t = setup();
    await t.svc.import({ source: 'url', url: 'https://archive.org/details/prideprejudice00aust/page/n5/mode/2up' });
    expect(t.items).toEqual(['prideprejudice00aust']);
    expect(downloads[0].link).toBe('https://archive.org/download/prideprejudice00aust/prideprejudice00aust.pdf');
  });

  it('removes the project again when the request was cancelled while the PDF was inspected', async () => {
    const ctrl = new AbortController();
    const t = setup({ onCreate: () => ctrl.abort() });
    await expect(t.svc.import({ source: 'archive', id: 'abc' }, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(t.remove).toHaveBeenCalledWith('proj-1', false);
  });
});

describe('LibraryService.search', () => {
  it('passes validated options to the archive, free books by default', async () => {
    const t = setup();
    await t.svc.search({ q: 'tagore', language: 'bn' });
    expect(t.archive.search).toHaveBeenCalledWith({ q: 'tagore', language: 'bn', freeOnly: true, page: 1 }, undefined);
    await t.svc.search({ free: 'false', page: '3' });
    expect(t.archive.search).toHaveBeenLastCalledWith({ q: '', language: 'any', freeOnly: false, page: 3 }, undefined);
  });

  it('rejects bad options', async () => {
    const t = setup();
    expect(() => t.svc.search({ page: '0' })).toThrow(/Invalid search/);
    expect(() => t.svc.search({ language: 'fr' })).toThrow(/Invalid search/);
    expect(() => t.svc.search({ q: 'x'.repeat(201) })).toThrow(/Invalid search/);
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { WorkerCallError } from '@app/pipeline';
import { AppError } from '@app/shared';
import type { PdfInspection } from '@app/types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ProjectsService } from '../src/projects/projects.service';
import type { QueueService } from '../src/queue/queue.service';
import type { PythonService } from '../src/system/python.service';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-api-svc-'));
const cfg = loadConfig({ STORAGE_DIR: tmp }, { reload: true });
const incoming = path.join(tmp, 'incoming');
fs.mkdirSync(incoming, { recursive: true });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const INFO: PdfInspection = {
  pageCount: 3,
  encrypted: false,
  needsPassword: false,
  title: 'The Sample Book',
  author: 'Tester',
  estimatedWords: 450,
  likelyScanned: false,
  hasToc: true,
  fileSize: 0,
};

type Calls = { method: string; args: unknown }[];

function setup(opts: { inspect?: () => PdfInspection; existingDocument?: boolean } = {}) {
  const calls: Calls = [];
  const rec = (method: string, result: (args: never) => unknown) => async (args: never) => {
    calls.push({ method, args });
    return result(args);
  };
  let created: { settings: unknown; name: string } | undefined;
  let upserted: { fileName: string; filePath: string; hash: string } | undefined;
  const prisma = {
    document: {
      upsert: rec('document.upsert', (a: { create: { fileName: string; filePath: string; hash: string } }) => {
        upserted = a.create;
        return { id: 'doc-1' };
      }),
      findUnique: rec('document.findUnique', () => (opts.existingDocument ? { id: 'doc-0' } : null)),
    },
    project: {
      create: rec('project.create', (a: { data: { settings: unknown; name: string } }) => {
        created = a.data;
        return { id: 'proj-1' };
      }),
      findUnique: rec('project.findUnique', () => ({
        id: 'proj-1',
        name: created?.name,
        status: 'PENDING',
        progress: 0,
        settings: created?.settings,
        snapshot: null,
        durationSec: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        document: { ...upserted, pageCount: 3, estimatedWords: 450, encrypted: false, likelyScanned: false, hasToc: true, fileSize: BigInt(123), title: 'The Sample Book', author: 'Tester' },
      })),
    },
    processingStep: { findMany: rec('processingStep.findMany', () => []) },
    chapter: { findMany: rec('chapter.findMany', () => []) },
    audioChunk: { findMany: rec('audioChunk.findMany', () => []) },
  };
  const python = {
    async call(method: string, params: unknown) {
      calls.push({ method: 'python.call', args: { method, params } });
      return (opts.inspect ?? (() => INFO))();
    },
  };
  const svc = new ProjectsService(cfg, prisma as unknown as PrismaService, {} as QueueService, python as unknown as PythonService);
  return { svc, calls, methods: () => calls.map((c) => c.method) };
}

let n = 0;
/** A fake multer upload in the incoming dir. Unique content → unique hash per test. */
function upload(content?: string): { file: Express.Multer.File; hash: string } {
  const body = content ?? `%PDF-1.7\n% test ${n++} ${crypto.randomUUID()}\n%%EOF\n`;
  const p = path.join(incoming, `${Date.now()}-${n}.pdf`);
  fs.writeFileSync(p, body);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return { file: { path: p, originalname: 'My Book.pdf', size: body.length } as Express.Multer.File, hash };
}

const stored = (hash: string) => fs.existsSync(path.join(cfg.storage.uploads, `${hash}.pdf`));
const uploads = () => fs.readdirSync(cfg.storage.uploads).filter((f) => f.endsWith('.pdf'));

describe('ProjectsService.create', () => {
  beforeEach(() => {
    for (const f of uploads()) fs.rmSync(path.join(cfg.storage.uploads, f));
  });

  it('stores the PDF by hash and creates the document + project', async () => {
    const t = setup();
    const { file, hash } = upload();
    const detail = await t.svc.create(file, JSON.stringify({ outputMode: 'audiobook_only', tts: { voice: 'af_sky' } }), '  ');

    expect(stored(hash)).toBe(true);
    expect(fs.existsSync(file.path)).toBe(false);
    expect(t.methods().slice(0, 3)).toEqual(['python.call', 'document.upsert', 'project.create']);
    expect(t.calls[0].args).toEqual({ method: 'pdf.inspect', params: { path: path.join(cfg.storage.uploads, `${hash}.pdf`) } });
    expect(detail).toMatchObject({ id: 'proj-1', name: 'The Sample Book', fileName: 'My Book.pdf', pageCount: 3, document: { hash, pageCount: 3, estimatedWords: 450, fileSize: 123 } });
    expect(detail.settings.outputMode).toBe('audiobook_only');
    expect(detail.settings.tts.voice).toBe('af_sky');
    expect(detail.settings.video.fps).toBeGreaterThan(0); // defaults merged in
  });

  it('rejects a non-PDF and removes the temp file', async () => {
    const t = setup();
    const { file } = upload('hello, I am a text file');
    await expect(t.svc.create(file)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This file is not a PDF.' });
    expect(fs.existsSync(file.path)).toBe(false);
    expect(uploads()).toEqual([]);
    expect(t.methods()).toEqual([]);
  });

  it('rejects a missing file', async () => {
    await expect(setup().svc.create(undefined as unknown as Express.Multer.File)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does not leave the PDF in storage/uploads when it is password-protected', async () => {
    const t = setup({
      inspect: () => {
        throw new WorkerCallError('PDF_PASSWORD', 'The PDF is password-protected.');
      },
    });
    const { file, hash } = upload();
    const err = await t.svc.create(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'PDF_PASSWORD', message: 'This PDF is password-protected. Remove the password and upload it again.' });
    expect(stored(hash)).toBe(false);
    expect(fs.existsSync(file.path)).toBe(false);
    expect(t.methods()).not.toContain('document.upsert');
  });

  it('does not leave the PDF in storage/uploads when it is a scan and OCR is off', async () => {
    const t = setup({ inspect: () => ({ ...INFO, likelyScanned: true }) });
    const { file, hash } = upload();
    await expect(t.svc.create(file, JSON.stringify({ text: { ocr: 'off' } }))).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('scan') });
    expect(stored(hash)).toBe(false);
  });

  it('validates settings before touching storage', async () => {
    for (const bad of ['{not json', JSON.stringify({ video: { fps: 500 } }), JSON.stringify({ tts: { engine: 'nope' } })]) {
      const t = setup();
      const { file, hash } = upload();
      await expect(t.svc.create(file, bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(stored(hash)).toBe(false);
      expect(fs.existsSync(file.path)).toBe(false);
      expect(t.methods()).toEqual([]);
    }
  });

  it('keeps an already-stored PDF that belongs to another document when a re-upload is rejected', async () => {
    const { file, hash } = upload();
    const dest = path.join(cfg.storage.uploads, `${hash}.pdf`);
    fs.copyFileSync(file.path, dest); // stored earlier by another project
    const t = setup({ inspect: () => ({ ...INFO, likelyScanned: true }), existingDocument: true });
    await expect(t.svc.create(file, JSON.stringify({ text: { ocr: 'off' } }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('rejects Bangla with the Kokoro engine', async () => {
    const t = setup();
    const { file, hash } = upload();
    await expect(t.svc.create(file, JSON.stringify({ language: 'bn' }))).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Bangla') });
    expect(stored(hash)).toBe(false);
  });
});

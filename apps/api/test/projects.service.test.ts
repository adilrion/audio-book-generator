import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { WorkerCallError } from '@app/pipeline';
import { AppError } from '@app/shared';
import { redisUnavailable } from '../src/common/errors';
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

// ── process(): start / resume ─────────────────────────────────────────────

interface FakeRenderJob {
  id: string;
  projectId: string;
  status: string;
  force: boolean;
  queueJobId?: string;
}

/**
 * In-memory project + RenderJob table. `$transaction(fn)` runs callbacks one at a time, like the
 * row lock (SELECT … FOR UPDATE) serializes them in Postgres.
 */
function processSetup(project: { status: string; snapshot?: unknown } = { status: 'PENDING' }) {
  const pdf = path.join(tmp, `doc-${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(pdf, '%PDF-1.7\n');
  const row = { id: 'proj-1', name: 'P', status: project.status, progress: 0, snapshot: project.snapshot ?? null, cancelRequested: false, updatedAt: new Date(), createdAt: new Date(), document: { filePath: pdf, hash: 'h' } };
  const jobs: FakeRenderJob[] = [];
  const log: string[] = [];
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const matches = (j: FakeRenderJob, where: { projectId: string; status?: string | { in: string[] } }) =>
    j.projectId === where.projectId && (where.status === undefined || (typeof where.status === 'string' ? j.status === where.status : where.status.in.includes(j.status)));
  const tick = () => new Promise((r) => setImmediate(r)); // let concurrent requests interleave
  const prisma = {
    project: {
      async findUnique() {
        await tick();
        return { ...row };
      },
      async update({ data }: { data: Record<string, unknown> }) {
        await tick();
        log.push(`project.update:${String(data.status ?? '-')}`);
        Object.assign(row, data);
        return { ...row };
      },
    },
    renderJob: {
      async findFirst({ where }: { where: { projectId: string; status?: string | { in: string[] } } }) {
        await tick();
        return jobs.find((j) => matches(j, where)) ?? null;
      },
      async create({ data }: { data: { projectId: string; force: boolean } }) {
        await tick();
        const j = { id: `rj-${++seq}`, status: 'PENDING', ...data };
        jobs.push(j);
        log.push('renderJob.create');
        return j;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<FakeRenderJob> }) {
        Object.assign(jobs.find((j) => j.id === where.id)!, data);
      },
      async delete({ where }: { where: { id: string } }) {
        jobs.splice(
          jobs.findIndex((j) => j.id === where.id),
          1,
        );
        log.push('renderJob.delete');
      },
    },
    processingStep: {
      async deleteMany() {
        log.push('processingStep.deleteMany');
      },
    },
    async $queryRaw(strings: TemplateStringsArray) {
      log.push(`sql:${strings.join('?').trim()}`);
      return [];
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      const run = tail.then(() => fn(prisma));
      tail = run.catch(() => undefined);
      return run;
    },
  };
  const queue = {
    enqueued: [] as { renderJobId: string }[],
    onEnqueue: undefined as undefined | (() => void | Promise<void>),
    async enqueue(data: { renderJobId: string }) {
      log.push('queue.enqueue');
      await queue.onEnqueue?.();
      queue.enqueued.push(data);
      return data.renderJobId;
    },
  };
  const svc = new ProjectsService(cfg, prisma as unknown as PrismaService, queue as unknown as QueueService, {} as PythonService);
  return { svc, row, jobs, queue, log };
}

describe('ProjectsService.process', () => {
  it('queues a render job and marks the project PENDING before the worker can see the job', async () => {
    const t = processSetup({ status: 'FAILED' });
    const { jobId } = await t.svc.process('proj-1');
    expect(jobId).toBe('rj-1');
    expect(t.jobs).toEqual([{ id: 'rj-1', projectId: 'proj-1', status: 'PENDING', force: false, queueJobId: 'rj-1' }]);
    expect(t.row).toMatchObject({ status: 'PENDING', cancelRequested: false, snapshot: { status: 'PENDING', message: 'Waiting for the worker…' } });
    expect(t.log.indexOf('project.update:PENDING')).toBeLessThan(t.log.indexOf('queue.enqueue'));
  });

  it('refuses a second start while the job is still queued', async () => {
    const t = processSetup();
    await t.svc.process('proj-1');
    await expect(t.svc.process('proj-1')).rejects.toMatchObject({ code: 'CONFLICT', message: 'This project is already queued.' });
    expect(t.queue.enqueued).toHaveLength(1);
  });

  it('refuses a second start after the worker picked the job up but before the project status changed', async () => {
    const t = processSetup();
    await t.svc.process('proj-1');
    t.jobs[0].status = 'EXTRACTING'; // worker took the job; runner has not written its first snapshot yet
    expect(t.row.status).toBe('PENDING');
    await expect(t.svc.process('proj-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(t.svc.process('proj-1', true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.queue.enqueued).toHaveLength(1);
    expect(t.log).not.toContain('processingStep.deleteMany'); // a refused restart must not wipe progress
  });

  it('lets exactly one of two simultaneous starts (double click) through', async () => {
    const t = processSetup();
    const results = await Promise.allSettled([t.svc.process('proj-1'), t.svc.process('proj-1')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'CONFLICT' });
    expect(t.queue.enqueued).toHaveLength(1);
    expect(t.jobs).toHaveLength(1);
    expect(t.log.some((l) => /FOR UPDATE/.test(l))).toBe(true);
  });

  it('does not overwrite a status the worker already wrote', async () => {
    const t = processSetup();
    t.queue.onEnqueue = () => {
      // a fast worker: picks the job up and reports progress before enqueue() even returns
      t.jobs[0].status = 'EXTRACTING';
      Object.assign(t.row, { status: 'EXTRACTING', snapshot: { status: 'EXTRACTING', progress: 1 } });
    };
    await t.svc.process('proj-1');
    expect(t.row.status).toBe('EXTRACTING');
    expect(t.row.snapshot).toEqual({ status: 'EXTRACTING', progress: 1 });
  });

  it('allows a new run once the previous one finished', async () => {
    const t = processSetup({ status: 'COMPLETED' });
    await t.svc.process('proj-1');
    t.jobs[0].status = 'COMPLETED';
    t.row.status = 'COMPLETED';
    await expect(t.svc.process('proj-1', true)).resolves.toEqual({ jobId: 'rj-2' });
    expect(t.log).toContain('processingStep.deleteMany');
  });

  it('refuses while the project is processing', async () => {
    const t = processSetup({ status: 'GENERATING_AUDIO' });
    await expect(t.svc.process('proj-1')).rejects.toMatchObject({ code: 'CONFLICT', message: 'This project is already processing.' });
    expect(t.jobs).toHaveLength(0);
  });

  it('rolls back when Redis is down: no render job left, previous status and error kept', async () => {
    const snapshot = { status: 'FAILED', progress: 40, error: { code: 'TTS_FAILED', message: 'Speech generation failed.', retryable: true } };
    const t = processSetup({ status: 'FAILED', snapshot });
    t.queue.onEnqueue = () => {
      throw redisUnavailable();
    };
    await expect(t.svc.process('proj-1')).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
    expect(t.jobs).toHaveLength(0);
    expect(t.row.status).toBe('FAILED');
    expect(t.row.snapshot).toEqual(snapshot);
    // and it can be started again once Redis is back
    t.queue.onEnqueue = undefined;
    await expect(t.svc.process('proj-1')).resolves.toEqual({ jobId: 'rj-2' });
  });

  it('reports a PDF missing from storage', async () => {
    const t = processSetup();
    fs.rmSync(t.row.document.filePath);
    await expect(t.svc.process('proj-1')).rejects.toMatchObject({ code: 'PDF_MISSING' });
    expect(t.jobs).toHaveLength(0);
  });
});

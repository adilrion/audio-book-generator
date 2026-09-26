/**
 * End-to-end test against the REAL running API (default http://localhost:4000, override with API_URL).
 * Skips automatically when the API, the sample PDF or the Python venv is not available.
 *
 * The sample PDF is uploaded as a byte-unique copy (a trailing PDF comment changes its hash but
 * not its content). DELETE /cache and project deletion remove hash-keyed caches (extraction, page
 * renders, previews), and those must not touch the caches of existing projects that use the
 * original file.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import type { OutputFile, ProgressSnapshot, ProjectDetail, StepRecord, Timeline } from '@app/types';
import { QUEUE_NAME, redisConnection } from '../src/queue/queue.service';

const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const SAMPLE_PDF = '/private/tmp/claude-501/sample-book.pdf';
const cfg = loadConfig();
const PYTHON = cfg.PYTHON_BIN;
const PROCESS_TIMEOUT_MS = 5 * 60_000;

const apiUp = await fetch(`${API}/system/config`, { signal: AbortSignal.timeout(3000) })
  .then((r) => r.ok)
  .catch(() => false);
const canRun = apiUp && fs.existsSync(SAMPLE_PDF) && fs.existsSync(PYTHON);
if (!canRun) console.warn(`[api.integration] skipped: api=${apiUp} samplePdf=${fs.existsSync(SAMPLE_PDF)} python=${fs.existsSync(PYTHON)}`);

type ErrorBody = { error: { code: string; message: string; hint?: string; retryable: boolean } };

async function call<T>(method: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${API}${url}`, { method, ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('json') && text) body = JSON.parse(text);
  return { status: res.status, body: body as T, headers: res.headers };
}
const json = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function uploadForm(bytes: Uint8Array, fileName: string, settings?: unknown, name?: string, type = 'application/pdf') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), fileName);
  if (settings !== undefined) form.append('settings', JSON.stringify(settings));
  if (name) form.append('name', name);
  return { body: form };
}

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = ['EXTRACTING', 'CLEANING', 'ANALYZING', 'GENERATING_AUDIO', 'PREPARING_VIDEO', 'RENDERING'];

describe.skipIf(!canRun)('API integration (live server)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-api-it-'));
  const created = new Set<string>();
  const strayUploads: string[] = [];
  const jobIds: string[] = [];
  const settings = { outputMode: 'audiobook_only', tts: { voice: 'af_sky' }, text: { chapterRange: { from: 2, to: 2 } } };
  const samplePdf = new Uint8Array(Buffer.concat([fs.readFileSync(SAMPLE_PDF), Buffer.from(`\n% api integration test ${crypto.randomUUID()}\n`)]));
  let project: ProjectDetail;

  afterAll(async () => {
    for (const id of created) {
      const st = await call<ProgressSnapshot>('GET', `/projects/${id}/status`).catch(() => null);
      if (st?.status === 200 && (ACTIVE.includes(st.body.status) || st.body.status === 'PENDING')) {
        await call('POST', `/projects/${id}/cancel`).catch(() => undefined);
        for (let i = 0; i < 60; i++) {
          const s = await call<ProgressSnapshot>('GET', `/projects/${id}/status`).catch(() => null);
          if (!s || !ACTIVE.includes(s.body.status)) break;
          await sleep(1000);
        }
      }
      if (st?.status === 200) await call('DELETE', `/projects/${id}?deleteOutputs=true`).catch(() => undefined);
    }
    // Rejected uploads that an API build without the orphan-upload fix leaves in storage/uploads.
    for (const f of strayUploads) fs.rmSync(f, { force: true });
    // BullMQ keeps finished jobs (removeOnComplete: 100); drop the ones this test created.
    if (jobIds.length) {
      const queue = new Queue(QUEUE_NAME, { connection: redisConnection(cfg.REDIS_URL, false) });
      queue.on('error', () => undefined);
      for (const id of jobIds) await queue.remove(id).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads the sample PDF and returns a ProjectDetail', async () => {
    const res = await call<ProjectDetail>('POST', '/projects', uploadForm(samplePdf, 'sample-book.pdf', settings, 'API integration test'));
    expect(res.status).toBe(201);
    project = res.body;
    created.add(project.id);

    expect(project).toMatchObject({ name: 'API integration test', fileName: 'sample-book.pdf', status: 'PENDING', progress: 0, pageCount: 3, steps: [], outputs: [], chapters: [] });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.document).toMatchObject({ hash: sha256(samplePdf), fileName: 'sample-book.pdf', pageCount: 3, encrypted: false, needsPassword: false, likelyScanned: false });
    expect(project.document.estimatedWords).toBeGreaterThan(0);
    expect(project.document.fileSize).toBe(samplePdf.byteLength);
    expect(project.settings.outputMode).toBe('audiobook_only');
    expect(project.settings.tts.voice).toBe('af_sky');
    expect(project.settings.text.chapterRange).toEqual({ from: 2, to: 2 });
    expect(project.settings.video.fps).toBeGreaterThan(0); // defaults merged in
    expect(project.snapshot.status).toBe('PENDING');

    const list = await call<{ id: string }[]>('GET', '/projects');
    expect(list.body.map((p) => p.id)).toContain(project.id);
  });

  it('reuses the Document for a duplicate upload and keeps a UTF-8 file name intact', async () => {
    const fileName = 'বাংলা বই – Ünïcode.pdf';
    const res = await call<ProjectDetail>('POST', '/projects', uploadForm(samplePdf, fileName, settings));
    expect(res.status).toBe(201);
    created.add(res.body.id);
    expect(res.body.id).not.toBe(project.id);
    expect(res.body.document.hash).toBe(project.document.hash); // same Document, stored once
    expect(res.body.fileName).toBe(fileName); // multer's latin1 default turned this into mojibake
    const del = await call<{ ok: boolean }>('DELETE', `/projects/${res.body.id}?deleteOutputs=true`);
    expect(del.status).toBe(200);
    created.delete(res.body.id);
    // the first project still owns the PDF
    expect(fs.existsSync(path.join(cfg.storage.uploads, `${project.document.hash}.pdf`))).toBe(true);
  });

  it('answers 413 (not 500) for a JSON body over the size limit', async () => {
    const res = await call<ErrorBody>('PATCH', `/projects/${project.id}/settings`, json({ padding: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'HTTP_413', message: 'The request is too large.', retryable: false });
  });

  it('rejects invalid settings on PATCH with 400 { error: { code, message } } and keeps the old settings', async () => {
    const bad = await call<ErrorBody>('PATCH', `/projects/${project.id}/settings`, json({ video: { fps: 500, highlightColor: 'yellow' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    expect(bad.body.error.message).toMatch(/^Invalid settings: /);
    expect(bad.body.error.message).toContain('video.fps');
    expect(bad.body.error.retryable).toBe(false);

    const engine = await call<ErrorBody>('PATCH', `/projects/${project.id}/settings`, json({ tts: { engine: 'elevenlabs' } }));
    expect(engine.status).toBe(400);
    expect(engine.body.error.message).toContain('tts.engine');

    const ok = await call<ProjectDetail>('PATCH', `/projects/${project.id}/settings`, json({ audio: { sentencePauseMs: 300 } }));
    expect(ok.status).toBe(200);
    expect(ok.body.settings.audio.sentencePauseMs).toBe(300);
    expect(ok.body.settings.tts.voice).toBe('af_sky');
    expect(ok.body.settings.text.chapterRange).toEqual({ from: 2, to: 2 });
    expect(ok.body.settings.outputMode).toBe('audiobook_only');
  });

  it('rejects a non-PDF upload with a friendly 400', async () => {
    const res = await call<ErrorBody>('POST', '/projects', uploadForm(new TextEncoder().encode('just some notes, not a pdf'), 'notes.pdf', undefined, undefined, 'text/plain'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'This file is not a PDF.', hint: 'Choose a .pdf file.', retryable: false });
  });

  it('rejects an upload without a file with a friendly 400', async () => {
    const form = new FormData();
    form.append('settings', '{}');
    const res = await call<ErrorBody>('POST', '/projects', { body: form });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Please choose a PDF file to upload.' });
  });

  it('rejects a password-protected PDF with 422 PDF_PASSWORD', async () => {
    const file = path.join(tmp, 'locked.pdf');
    const script = [
      'import sys, pymupdf',
      'doc = pymupdf.open()',
      'doc.new_page().insert_text((72, 72), "Top secret chapter text for the password test.")',
      'doc.save(sys.argv[1], encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="user-secret", owner_pw="owner-secret")',
    ].join('\n');
    execFileSync(PYTHON, ['-c', script, file]);
    const bytes = new Uint8Array(fs.readFileSync(file));
    const storedAs = path.join(cfg.storage.uploads, `${sha256(bytes)}.pdf`);
    if (!fs.existsSync(storedAs)) strayUploads.push(storedAs);

    const res = await call<ErrorBody>('POST', '/projects', uploadForm(bytes, 'locked.pdf'));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'PDF_PASSWORD', message: 'This PDF is password-protected. Remove the password and upload it again.', retryable: false });
    expect(JSON.stringify(res.body)).not.toMatch(/Traceback|pymupdf|fitz/i);
  });

  it('reports NOT_READY for the timeline before processing', async () => {
    const res = await call<ErrorBody>('GET', `/projects/${project.id}/timeline`);
    // 409 since the error-filter fix; a server built before it answers 500 with the same body.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatchObject({ code: 'NOT_READY', retryable: false });
  });

  it(
    'processes the project to COMPLETED',
    async () => {
      const start = await call<{ jobId: string }>('POST', `/projects/${project.id}/process`);
      expect(start.status).toBe(201);
      expect(typeof start.body.jobId).toBe('string');
      jobIds.push(start.body.jobId);

      const deadline = Date.now() + PROCESS_TIMEOUT_MS;
      let last: ProgressSnapshot | undefined;
      let conflictChecked = false;
      while (Date.now() < deadline) {
        const st = await call<ProgressSnapshot>('GET', `/projects/${project.id}/status`);
        expect(st.status).toBe(200);
        last = st.body;
        expect(last.progress).toBeGreaterThanOrEqual(0);
        expect(last.progress).toBeLessThanOrEqual(100);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(last.status)) break;
        if (!conflictChecked && ACTIVE.includes(last.status)) {
          // While running, a second start and settings changes are refused.
          // (The instant double-click case is covered by the ProjectsService.process unit tests.)
          conflictChecked = true;
          const again = await call<ErrorBody & { jobId?: string }>('POST', `/projects/${project.id}/process`);
          if (again.body.jobId) jobIds.push(again.body.jobId);
          expect(again.status).toBe(409);
          expect(again.body.error).toMatchObject({ code: 'CONFLICT', message: 'This project is already processing.' });
          const patch = await call<ErrorBody>('PATCH', `/projects/${project.id}/settings`, json({ tts: { speed: 1.2 } }));
          expect(patch.status).toBe(409);
          expect(patch.body.error.code).toBe('CONFLICT');
        }
        await sleep(conflictChecked ? 1000 : 100);
      }
      expect(last?.error, `processing failed: ${JSON.stringify(last?.error)}`).toBeUndefined();
      expect(last?.status).toBe('COMPLETED');
      expect(conflictChecked, 'never observed the project in a running state').toBe(true);
      expect(last?.progress).toBe(100);

      const steps = await call<StepRecord[]>('GET', `/projects/${project.id}/steps`);
      const keys = steps.body.map((s) => s.key);
      expect(keys).toEqual(expect.arrayContaining(['EXTRACT', 'CLEAN', 'ANALYZE', 'TTS_CHAPTER_2', 'AUDIO_MERGE', 'TIMELINE']));
      expect(keys.filter((k) => k.startsWith('TTS_CHAPTER_'))).toEqual(['TTS_CHAPTER_2']);
      expect(keys.some((k) => k.startsWith('VIDEO_CHAPTER_') || k === 'MUX')).toBe(false);
      expect(steps.body.every((s) => s.status === 'COMPLETED')).toBe(true);

      const detail = await call<ProjectDetail>('GET', `/projects/${project.id}`);
      expect(detail.body.status).toBe('COMPLETED');
      expect(detail.body.durationSec).toBeGreaterThan(0);
      expect(detail.body.chapters.length).toBeGreaterThanOrEqual(2);
      expect(detail.body.chapters.find((c) => c.index === 1)?.durationSec).toBeGreaterThan(0);
      expect(detail.body.chapters.filter((c) => c.durationSec !== undefined).map((c) => c.index)).toEqual([1]);
    },
    PROCESS_TIMEOUT_MS + 30_000,
  );

  it('lists audio + subtitles outputs and no video in audio-only mode', async () => {
    const res = await call<OutputFile[]>('GET', `/projects/${project.id}/output`);
    expect(res.status).toBe(200);
    const names = res.body.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['audiobook.m4a', 'subtitles.srt']));
    expect(names).not.toContain('audiobook.mp4');
    for (const o of res.body) {
      expect(o.size).toBeGreaterThan(0);
      expect(o.url).toBe(`/projects/${project.id}/output/${o.name}`);
    }
    expect(res.body.find((o) => o.name === 'audiobook.m4a')?.kind).toBe('audio');

    const srt = await call<string>('GET', `/projects/${project.id}/output/subtitles.srt`);
    expect(srt.status).toBe(200);
    expect(srt.headers.get('content-disposition')).toContain('attachment');
    expect(srt.body).toMatch(/^1\r?\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}/);
  });

  it('returns a timeline with segments only for the selected chapter (index 1)', async () => {
    const res = await call<Timeline>('GET', `/projects/${project.id}/timeline`);
    expect(res.status).toBe(200);
    const t = res.body;
    expect(t.duration).toBeGreaterThan(0);
    expect(t.fps).toBeGreaterThan(0);
    expect(t.segments.length).toBeGreaterThan(0);
    expect(new Set(t.segments.map((s) => s.chapterIndex))).toEqual(new Set([1]));
    expect(t.segments.every((s) => s.sentenceId.startsWith('c1-'))).toBe(true);
    let prevEnd = 0;
    for (const s of t.segments) {
      expect(s.start).toBeGreaterThanOrEqual(prevEnd - 1e-6);
      expect(s.end).toBeGreaterThan(s.start);
      expect(t.pageSizes[String(s.page)]).toHaveLength(2);
      for (const r of s.rects) expect(r).toHaveLength(4);
      prevEnd = s.end;
    }
    expect(t.segments.at(-1)!.end).toBeLessThanOrEqual(t.duration + 1e-6);
  });

  it('serves the m4a with Range support (206) for seeking', async () => {
    const res = await fetch(`${API}/projects/${project.id}/output/audiobook.m4a?inline=1`, { headers: { Range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/);
    expect(res.headers.get('content-disposition')).toBeNull(); // inline
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(1024);
    expect(Buffer.from(buf.subarray(4, 8)).toString('latin1')).toBe('ftyp'); // MP4/M4A container
  });

  it('rejects unsafe output names', async () => {
    for (const name of ['.env', 'manifest..json%2F..%2F..%2Fpackage.json', '..%2F..%2Fpackage.json']) {
      const res = await call<ErrorBody>('GET', `/projects/${project.id}/output/${name}`);
      expect(res.status).toBe(404);
    }
  });

  it('rejects path traversal through the project id', async () => {
    // storage/output/../../package.json = the repo's package.json; ../../../../../../etc/hosts
    for (const url of ['/projects/..%2F../output/package.json', '/projects/..%2F..%2F..%2F..%2F..%2F..%2Fetc/output/hosts', '/projects/..%2F../output']) {
      const res = await call<ErrorBody>('GET', url);
      expect(res.status, url).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('pdf-audiobook');
    }
  });

  it('renders a page image as JPEG', async () => {
    const res = await fetch(`${API}/projects/${project.id}/pages/2/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/jpeg');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const outOfRange = await call<ErrorBody>('GET', `/projects/${project.id}/pages/99/image`);
    expect(outOfRange.status).toBe(404);
    expect(outOfRange.body.error.code).toBe('NOT_FOUND');
    const notNumeric = await call<ErrorBody>('GET', `/projects/${project.id}/pages/abc/image`);
    expect(notNumeric.status).toBe(400);
  });

  it('cleans the cache without deleting the final outputs', async () => {
    const res = await call<{ freedBytes: number }>('DELETE', `/projects/${project.id}/cache`);
    expect(res.status).toBe(200);
    expect(typeof res.body.freedBytes).toBe('number');
    expect(res.body.freedBytes).toBeGreaterThan(0);

    const outputs = await call<OutputFile[]>('GET', `/projects/${project.id}/output`);
    expect(outputs.body.map((o) => o.name)).toEqual(expect.arrayContaining(['audiobook.m4a', 'subtitles.srt']));
    const m4a = await fetch(`${API}/projects/${project.id}/output/audiobook.m4a`, { headers: { Range: 'bytes=0-15' } });
    expect(m4a.status).toBe(206);
    await m4a.arrayBuffer();
    expect((await call('GET', `/projects/${project.id}/timeline`)).status).toBe(200);
  });

  it('deletes the project together with its outputs', async () => {
    const res = await call<{ ok: boolean; outputsKept: boolean }>('DELETE', `/projects/${project.id}?deleteOutputs=true`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outputsKept: false });
    created.delete(project.id);

    expect((await call<ErrorBody>('GET', `/projects/${project.id}`)).status).toBe(404);
    expect((await call<ErrorBody>('GET', `/projects/${project.id}/output/audiobook.m4a`)).status).toBe(404);
    expect(fs.existsSync(path.join(cfg.storage.output, project.id))).toBe(false);
    expect(fs.existsSync(path.join(cfg.storage.uploads, `${project.document.hash}.pdf`))).toBe(false);
    expect((await call<{ id: string }[]>('GET', '/projects')).body.map((p) => p.id)).not.toContain(project.id);
  });
});

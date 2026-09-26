import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { resolveSettings } from '@app/types';
import { MemoryStore, PipelineRunner, cleanProjectCache, deleteProjectFiles, type PipelineJob } from '../src';
import { FakeTTS, hasFfmpeg, samplePdf } from './runner-fakes';

const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);
const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

describe.skipIf(!hasPython || !hasFfmpeg)('cleanProjectCache / cleanupIntermediate', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-clean-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, KEEP_INTERMEDIATE: false as never, VIDEO_BITRATE: '300k' }, { reload: true });
  const pdf = path.join(tmp, 'book.pdf');
  const settings = resolveSettings({ outputMode: 'audiobook_only', video: { width: 160, height: 90, fps: 5 }, text: { useLlm: false } });
  const job = (projectId: string, over: Partial<PipelineJob> = {}): PipelineJob => ({ projectId, pdfPath: pdf, pdfHash: 'cleanhash', title: 'Clean', settings, ...over });
  const runJob = (j: PipelineJob, tts: FakeTTS) => new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts }).run(j);

  beforeAll(() => {
    samplePdf(cfg, pdf, 2, 3);
  });

  it('never deletes cache entries another project still uses (same PDF + settings)', async () => {
    const tts = new FakeTTS();
    await runJob(job('shareA'), tts);
    await runJob(job('shareB'), tts);
    await cleanProjectCache(cfg, 'shareA', 'cleanhash');
    const before = tts.calls;
    const store = new MemoryStore();
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job('shareB'));
    expect(tts.calls).toBe(before); // B's narration survived A's cleanup
    expect(store.steps.find((s) => s.key === 'EXTRACT')!.cached).toBe(true);
    // B's final outputs are untouched either way
    expect(fs.existsSync(path.join(cfg.storage.output, 'shareB', 'audiobook.m4a'))).toBe(true);
  }, 120_000);

  it('removes the finished chapters of a failed run and entries of earlier settings', async () => {
    const tts = new FakeTTS();
    const pid = 'partial';
    // run 1: voice X completes
    await runJob(job(pid, { pdfHash: 'parthash' }), tts);
    // run 2: voice Y fails on the last chapter after the first two finished
    const voiced = { ...settings, tts: { ...settings.tts, voice: 'am_adam' } };
    const orig = cfg.MAX_CONCURRENT_TTS;
    (cfg as { MAX_CONCURRENT_TTS: number }).MAX_CONCURRENT_TTS = 1;
    tts.failOn = (segs) => segs.some((s) => s.id.startsWith('c2-'));
    try {
      await expect(runJob(job(pid, { pdfHash: 'parthash', settings: voiced }), tts)).rejects.toMatchObject({ code: 'TTS_FAILED' });
    } finally {
      tts.failOn = undefined;
      (cfg as { MAX_CONCURRENT_TTS: number }).MAX_CONCURRENT_TTS = orig;
    }
    const audioBefore = files(cfg.storage.audio).filter((f) => f.endsWith('.flac'));
    await cleanProjectCache(cfg, pid, 'parthash');
    const left = files(cfg.storage.audio).filter((f) => f.endsWith('.flac'));
    // only the other describe-level project's entries (shareA/shareB) may remain
    const shared = new Set(JSON.parse(fs.readFileSync(path.join(cfg.storage.output, 'shareB', 'manifest.json'), 'utf8')).audioKeys.map((k: string) => `${k}.flac`));
    expect(audioBefore.length).toBeGreaterThan(shared.size);
    expect(left.filter((f) => !shared.has(f))).toEqual([]);
    expect(fs.existsSync(path.join(cfg.storage.output, pid, 'audiobook.m4a'))).toBe(true); // final output kept
  }, 120_000);

  it('deleteProjectFiles keeps outputs unless asked, and cleanupIntermediate keeps chapter audio', async () => {
    const tts = new FakeTTS();
    const video = { ...settings, outputMode: 'audiobook_video' as const };
    const r = await runJob(job('vid', { pdfHash: 'vidhash', settings: video }), tts);
    const out = path.join(cfg.storage.output, 'vid');
    expect(files(out)).toEqual(expect.arrayContaining(['audiobook.m4a', 'audiobook.mp4', 'subtitles.srt', 'timeline.json', 'chapters.txt']));
    // cleanupIntermediate: segments + page images gone, chapter audio (TTS cache) kept
    expect(files(path.join(cfg.storage.renders, 'video')).filter((f) => f.endsWith('.mp4'))).toEqual([]);
    expect(fs.existsSync(path.join(cfg.storage.renders, 'pages', 'vidhash'))).toBe(false);
    expect(r.outputs.length).toBeGreaterThan(0);
    await deleteProjectFiles(cfg, 'vid', 'vidhash', { deleteOutputs: false, deleteUpload: false });
    expect(files(out)).toEqual(expect.arrayContaining(['audiobook.m4a', 'audiobook.mp4', 'subtitles.srt']));
    await deleteProjectFiles(cfg, 'vid', 'vidhash', { deleteOutputs: true, deleteUpload: false });
    expect(fs.existsSync(out)).toBe(false);
  }, 120_000);
});

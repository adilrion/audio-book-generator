import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { resolveSettings, type StepRecord } from '@app/types';
import { FileStore, MemoryStore, PipelineRunner, type PipelineJob } from '../src';
import { FakeTTS, hasFfmpeg, samplePdf } from './runner-fakes';

const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);

/** Processes (pid → command) whose command line mentions `needle`. */
function procsMatching(needle: string): string[] {
  return execFileSync('ps', ['-axo', 'pid,ppid,command']).toString().split('\n').filter((l) => l.includes(needle) && !l.includes('ps -axo'));
}
const pythonChildren = () =>
  execFileSync('ps', ['-axo', 'pid,ppid,command'])
    .toString()
    .split('\n')
    .filter((l) => l.includes('audiobook_worker.server') && Number(l.trim().split(/\s+/)[1]) === process.pid);
const hiddenTemps = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('.')) : []);

describe.skipIf(!hasPython || !hasFfmpeg)('runner resume / cancel', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, KEEP_INTERMEDIATE: false as never, VIDEO_BITRATE: '300k' }, { reload: true });
  const pdf = path.join(tmp, 'book.pdf');
  const settings = resolveSettings({ video: { width: 192, height: 108, fps: 10 }, text: { useLlm: false } });
  const job: PipelineJob = { projectId: 'resume', pdfPath: pdf, pdfHash: 'resumehash', title: 'Resume', settings };

  beforeAll(() => {
    samplePdf(cfg, pdf, 2, 3);
  });

  it('on resume, steps from the previous run are not shown as done before this run checks them', async () => {
    const tts = new FakeTTS();
    const dir = path.join(tmp, 'state');
    await new PipelineRunner(cfg, new FileStore(dir), undefined, { tts: () => tts }).run(job);
    // Second run with a different theme: every video step + MUX must be redone.
    const dark = { ...job, settings: { ...settings, video: { ...settings.video, theme: 'dark' as const } } };
    let atFirstRender: StepRecord[] | undefined;
    await new PipelineRunner(cfg, new FileStore(dir), undefined, {
      tts: () => tts,
      onSnapshot: (_s, steps) => {
        if (!atFirstRender && steps.some((st) => st.key.startsWith('VIDEO_CHAPTER_') && st.status === 'RUNNING')) atFirstRender = steps.map((st) => ({ ...st }));
      },
    }).run(dark);
    const at = Object.fromEntries(atFirstRender!.map((s) => [s.key, s]));
    expect(at.TTS_CHAPTER_1).toMatchObject({ status: 'COMPLETED', cached: true }); // checked in this run
    expect(at.MUX.status).toBe('PENDING'); // not the stale COMPLETED of the last run
    expect(at.VIDEO_CHAPTER_3.status).not.toBe('COMPLETED');
  }, 180_000);

  it('steps that are not part of this run (chapter range) are marked skipped, not left as stale', async () => {
    const tts = new FakeTTS();
    const store = new MemoryStore();
    const audioOnly = { ...job, projectId: 'range', settings: { ...settings, outputMode: 'audiobook_only' as const } };
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(audioOnly);
    const ranged = { ...audioOnly, settings: { ...audioOnly.settings, text: { ...audioOnly.settings.text, chapterRange: { from: 1, to: 1 } } } };
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(ranged);
    const st = Object.fromEntries(store.steps.map((s) => [s.key, s]));
    expect(st.TTS_CHAPTER_1).toMatchObject({ status: 'COMPLETED', cached: true });
    expect(st.TTS_CHAPTER_2.status).toBe('SKIPPED');
    expect(st.TTS_CHAPTER_3.status).toBe('SKIPPED');
  }, 120_000);

  it('cancel mid-render: no python/ffmpeg left running, partial temp files cleaned by the next successful run', async () => {
    // Long chapters so rendering is still running when we abort.
    const tts = new FakeTTS({ perWord: 1.2 });
    const cancelJob = { ...job, projectId: 'cancel', pdfHash: 'cancelhash' };
    const ac = new AbortController();
    const runner = new PipelineRunner(cfg, new MemoryStore(), undefined, {
      tts: () => tts,
      onSnapshot: (s) => {
        if (s.stage === 'VIDEO' && /frame/.test(s.message ?? '') && !ac.signal.aborted) ac.abort();
      },
    });
    await expect(runner.run(cancelJob, { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(pythonChildren()).toEqual([]);
    const videoDir = path.join(cfg.storage.renders, 'video');
    // ffmpeg (child of the killed python) sees EOF and exits on its own.
    const t0 = Date.now();
    while (procsMatching(videoDir).length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    expect(procsMatching(videoDir)).toEqual([]);
    expect(hiddenTemps(videoDir).length).toBeGreaterThan(0); // precondition: the kill left partials behind
    // Leftovers are only swept once they are clearly abandoned (>1 min old): age them.
    const old = new Date(Date.now() - 3600_000);
    for (const f of hiddenTemps(videoDir)) fs.utimesSync(path.join(videoDir, f), old, old);

    await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts }).run(cancelJob);
    expect(hiddenTemps(videoDir)).toEqual([]);
    expect(hiddenTemps(cfg.storage.audio)).toEqual([]);
  }, 300_000);
});

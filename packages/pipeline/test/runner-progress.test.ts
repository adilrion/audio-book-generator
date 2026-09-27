import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { resolveSettings, type ProgressSnapshot, type StepRecord } from '@app/types';
import { MemoryStore, PipelineRunner, WorkerCallError, type PipelineJob } from '../src';
import { FakeTTS, hasFfmpeg, samplePdf } from './runner-fakes';

const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store whose intermediate writes are slow (busy DB) while final ones are fast. */
class SlowStore extends MemoryStore {
  persistedSnapshot?: ProgressSnapshot;
  persistedSteps = new Map<string, StepRecord>();
  override async updateSnapshot(s: ProgressSnapshot) {
    const c = structuredClone(s);
    await sleep(['COMPLETED', 'FAILED', 'CANCELLED'].includes(c.status) ? 1 : 1200);
    this.persistedSnapshot = c;
  }
  override async updateStep(st: StepRecord) {
    const c = structuredClone(st);
    await sleep(c.status === 'RUNNING' && c.progress > 0 ? 1200 : 1);
    this.persistedSteps.set(c.key, c);
    await super.updateStep(c);
  }
}

describe.skipIf(!hasPython || !hasFfmpeg)('runner progress, persistence and error messages', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-progress-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, VIDEO_BITRATE: '300k' }, { reload: true });
  const pdf = path.join(tmp, 'book.pdf');
  const settings = resolveSettings({ video: { width: 160, height: 90, fps: 5 }, text: { useLlm: false } });
  const job = (projectId: string, over: Partial<PipelineJob> = {}): PipelineJob => ({ projectId, pdfPath: pdf, pdfHash: `h-${projectId}`, title: 'P', settings, ...over });

  beforeAll(() => {
    samplePdf(cfg, pdf, 2, 3);
  });

  it.each(['audiobook_only', 'audiobook_video'] as const)('overall progress is monotonic and ends at 100 (%s)', async (mode) => {
    const seen: number[] = [];
    const store = new MemoryStore();
    const tts = new FakeTTS();
    const j = job(`mono-${mode}`, { settings: { ...settings, outputMode: mode } });
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts, onSnapshot: (s) => seen.push(s.progress) }).run(j);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.at(-1)).toBe(100);
    expect(store.snapshots.at(-1)).toMatchObject({ status: 'COMPLETED', progress: 100 });
    // resumed (all cached) run also climbs to 100 without going backwards
    const again: number[] = [];
    await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts, onSnapshot: (s) => again.push(s.progress) }).run(j);
    for (let i = 1; i < again.length; i++) expect(again[i]).toBeGreaterThanOrEqual(again[i - 1]);
    expect(again.at(-1)).toBe(100);
  }, 120_000);

  it('a slow store never ends up with a stale snapshot or a step stuck RUNNING', async () => {
    const store = new SlowStore();
    const tts = new FakeTTS();
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job('slow', { settings: { ...settings, outputMode: 'audiobook_only' } }));
    await sleep(1500); // let any fire-and-forget write land
    expect(store.persistedSnapshot).toMatchObject({ status: 'COMPLETED', progress: 100 });
    const stuck = [...store.persistedSteps.values()].filter((s) => s.status !== 'COMPLETED');
    expect(stuck).toEqual([]);
  }, 120_000);

  it('a failed run persists FAILED last, with the friendly chapter message + retry hint', async () => {
    const store = new SlowStore();
    const tts = new FakeTTS();
    tts.failOn = (segs) => segs.some((s) => s.id.startsWith('c2-'));
    const orig = cfg.MAX_CONCURRENT_TTS;
    (cfg as { MAX_CONCURRENT_TTS: number }).MAX_CONCURRENT_TTS = 1;
    try {
      await expect(new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job('fail', { settings: { ...settings, outputMode: 'audiobook_only', tts: { ...settings.tts, voice: 'v_fail' } } }))).rejects.toMatchObject({
        code: 'TTS_FAILED',
      });
    } finally {
      (cfg as { MAX_CONCURRENT_TTS: number }).MAX_CONCURRENT_TTS = orig;
    }
    await sleep(1500);
    expect(store.persistedSnapshot?.status).toBe('FAILED');
    expect(store.persistedSnapshot?.error).toMatchObject({ message: 'Audio generation failed for Chapter 3.', stepKey: 'TTS_CHAPTER_3', chapterIndex: 2, retryable: true });
    expect(store.persistedSnapshot?.error?.hint).toMatch(/Retry to continue from Chapter 3/);
    expect(store.persistedSteps.get('TTS_CHAPTER_3')?.status).toBe('FAILED');
  }, 120_000);

  it('out-of-memory during TTS keeps the memory hint', async () => {
    const tts = new FakeTTS();
    tts.failOn = () => {
      throw new WorkerCallError('OUT_OF_MEMORY', 'Worker ran out of memory', undefined, true);
    };
    const err = await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts }).run(job('oom', { settings: { ...settings, outputMode: 'audiobook_only', tts: { ...settings.tts, voice: 'v_oom' } } })).catch((e) => e);
    expect(err.message).toMatch(/^Audio generation failed for Chapter \d\.$/);
    expect(err.hint).toMatch(/MAX_CONCURRENT_TTS/);
  }, 120_000);

  /** Up to `times` times, when a (new) renderer reports frames, kill every Python child of this test. */
  function killRenderer(times: number) {
    const killed = new Set<number>();
    let kills = 0;
    return {
      get kills() {
        return kills;
      },
      onSnapshot: (s: { stage?: string; message?: string }) => {
        if (kills >= times || s.stage !== 'VIDEO' || !/frame|rendering pages/.test(s.message ?? '')) return;
        const rows = execFileSync('ps', ['-axo', 'pid,ppid,command']).toString().split('\n');
        const fresh = rows
          .filter((l) => l.includes('audiobook_worker.server'))
          .map((l) => l.trim().split(/\s+/).map(Number))
          .filter(([pid, ppid]) => ppid === process.pid && !killed.has(pid))
          .map(([pid]) => pid);
        if (!fresh.length) return;
        kills++; // simulate macOS killing the renderer (memory pressure)
        for (const pid of fresh) {
          killed.add(pid);
          process.kill(pid, 'SIGKILL');
        }
      },
    };
  }

  it('a render worker that dies once is restarted and the chapter is retried', async () => {
    const tts = new FakeTTS({ perWord: 1 });
    const k = killRenderer(1);
    const r = await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts, onSnapshot: k.onSnapshot }).run(
      job('crash-once', { settings: { ...settings, video: { ...settings.video, width: 192, height: 108 } } }),
    );
    expect(k.kills).toBe(1);
    expect(r.outputs.map((o) => o.name)).toContain('audiobook.mp4');
    expect(r.warnings).toContain('A processing worker stopped unexpectedly and was restarted automatically.');
  }, 120_000);

  it('a render worker that keeps dying reports which chapter failed', async () => {
    const tts = new FakeTTS({ perWord: 1 });
    const k = killRenderer(Infinity);
    const runner = new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts, onSnapshot: k.onSnapshot });
    const err = await runner.run(job('crash', { settings: { ...settings, video: { ...settings.video, width: 192, height: 108 } } })).catch((e) => e);
    expect(k.kills).toBeGreaterThanOrEqual(2);
    expect(err.message).toMatch(/^Video rendering failed for Chapter \d\.$/);
    expect(err.hint).toMatch(/finished chapters are kept/);
    expect(err.stepKey).toMatch(/^VIDEO_CHAPTER_\d$/);
  }, 120_000);
});

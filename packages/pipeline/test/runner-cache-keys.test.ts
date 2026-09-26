import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { sha256File } from '@app/shared';
import { resolveSettings, type ProjectSettings, type StepRecord, type Timeline } from '@app/types';
import { MemoryStore, PipelineRunner, type PipelineJob } from '../src';
import { FakeTTS, hasFfmpeg, probeTags, samplePdf } from './runner-fakes';

const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);

const byKey = (steps: StepRecord[]) => Object.fromEntries(steps.map((s) => [s.key, s]));
const videoSteps = (steps: StepRecord[]) => steps.filter((s) => s.key.startsWith('VIDEO_CHAPTER_'));
/** Stream types, ignoring the MP4 chapter text track (reported as `data`). */
const streamTypes = (file: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).toString().trim().split('\n').filter((t) => t !== 'data').sort();

describe.skipIf(!hasPython || !hasFfmpeg)('runner cache keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-keys-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, KEEP_INTERMEDIATE: false as never, VIDEO_BITRATE: '500k' }, { reload: true });
  const setKeep = (v: boolean) => ((cfg as { KEEP_INTERMEDIATE: boolean }).KEEP_INTERMEDIATE = v);
  const tts = new FakeTTS();
  const settings = resolveSettings({ video: { width: 160, height: 90, fps: 5 }, text: { useLlm: false } });
  const pdfA = path.join(tmp, 'a.pdf');
  const pdfB = path.join(tmp, 'b.pdf');
  let hashA = '';
  let hashB = '';

  const runJob = async (job: PipelineJob, store = new MemoryStore()) => {
    const r = await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job);
    return { r, store, st: byKey(store.steps) };
  };
  const jobFor = (over: Partial<PipelineJob> & { settings?: ProjectSettings } = {}): PipelineJob => ({
    projectId: 'pa',
    pdfPath: pdfA,
    pdfHash: hashA,
    title: 'Book A',
    settings,
    ...over,
  });

  beforeAll(async () => {
    samplePdf(cfg, pdfA, 2, 3);
    // Same text & layout, different artwork: a filled box in the top margin of page 1.
    execFileSync(cfg.PYTHON_BIN, ['-c', `import fitz,sys\nd=fitz.open(sys.argv[1]);p=d[0];p.draw_rect(fitz.Rect(0,0,p.rect.width,40),color=(1,0,0),fill=(1,0,0));d.save(sys.argv[2])`, pdfA, pdfB], {
      env: { ...process.env, PYTHONPATH: cfg.workerDir },
    });
    hashA = await sha256File(pdfA);
    hashB = await sha256File(pdfB);
  });

  it('project title is part of the analysis + audio metadata (renamed book is not stale)', async () => {
    const audioOnly = { ...settings, outputMode: 'audiobook_only' as const };
    const first = await runJob(jobFor({ projectId: 'title', settings: audioOnly, title: 'First Title' }));
    expect(first.r.analysis.title).toBe('First Title');
    const calls = tts.calls;
    const second = await runJob(jobFor({ projectId: 'title', settings: audioOnly, title: 'Second Title' }));
    expect(second.r.analysis.title).toBe('Second Title');
    const m4a = second.r.outputs.find((o) => o.name === 'audiobook.m4a')!.path;
    expect((await probeTags(cfg, m4a)).title).toBe('Second Title');
    expect(tts.calls).toBe(calls); // narration reused
    expect(second.st.TTS_CHAPTER_1.cached).toBe(true);
  }, 120_000);

  it('a different PDF with identical text never reuses video segments rendered from another PDF', async () => {
    setKeep(true);
    try {
      await runJob(jobFor({ projectId: 'pdf-a' }));
      const b = await runJob(jobFor({ projectId: 'pdf-b', pdfPath: pdfB, pdfHash: hashB }));
      expect(b.st.TTS_CHAPTER_1.cached).toBe(true); // same words → narration reused (correct)
      expect(videoSteps(b.store.steps).map((s) => s.cached)).toEqual([false, false, false]);
    } finally {
      setKeep(false);
    }
  }, 180_000);

  it('toggling embedded subtitles only re-muxes (no video re-render after cleanup)', async () => {
    const job = jobFor({ projectId: 'subs' });
    const first = await runJob(job);
    expect(first.st.MUX.cached).toBe(false);
    const noSubs = { ...settings, video: { ...settings.video, embedSubtitles: false } };
    const second = await runJob({ ...job, settings: noSubs });
    expect(second.st.MUX.cached).toBe(false);
    expect(videoSteps(second.store.steps).every((s) => s.cached)).toBe(true);
    const mp4 = second.r.outputs.find((o) => o.name === 'audiobook.mp4')!.path;
    expect(streamTypes(mp4)).toEqual(['audio', 'video']);
    // and back on: subtitles return, still without rendering
    const third = await runJob(job);
    expect(videoSteps(third.store.steps).every((s) => s.cached)).toBe(true);
    expect(streamTypes(mp4)).toEqual(['audio', 'subtitle', 'video']);
  }, 180_000);

  it('audio normalization change re-masters + re-muxes without re-rendering video', async () => {
    const job = jobFor({ projectId: 'norm' });
    await runJob(job);
    const loud = { ...settings, audio: { ...settings.audio, normalize: false } };
    const second = await runJob({ ...job, settings: loud });
    expect(second.st.AUDIO_MERGE.cached).toBe(false);
    expect(second.st.TTS_CHAPTER_1.cached).toBe(true);
    expect(videoSteps(second.store.steps).every((s) => s.cached)).toBe(true);
  }, 180_000);

  it('chapter range reuses analysis + narration; showProgress re-renders every segment', async () => {
    setKeep(true);
    try {
      const job = jobFor({ projectId: 'range' });
      await runJob(job);
      const ranged = await runJob({ ...job, settings: { ...settings, text: { ...settings.text, chapterRange: { from: 2, to: 3 } } } });
      expect(ranged.st.EXTRACT.cached).toBe(true);
      expect(ranged.st.ANALYZE.cached).toBe(true);
      expect(ranged.st.TTS_CHAPTER_2.cached).toBe(true);
      expect(ranged.st.TTS_CHAPTER_3.cached).toBe(true);
      const noBar = await runJob({ ...job, settings: { ...settings, video: { ...settings.video, showProgress: false } } });
      expect(videoSteps(noBar.store.steps).map((s) => s.cached)).toEqual([false, false, false]);
      expect(noBar.st.TTS_CHAPTER_1.cached).toBe(true);
    } finally {
      setKeep(false);
    }
  }, 180_000);

  it('a failure after writing timeline.json never leaves it looking current for other settings', async () => {
    const job = jobFor({ projectId: 'tl', settings: { ...settings, outputMode: 'audiobook_only' } });
    await runJob(job);
    // Second run with paragraph highlighting: the store fails right after timeline.json was rewritten.
    const para = { ...job.settings, video: { ...job.settings.video, highlightMode: 'paragraph' as const } };
    const flaky = new MemoryStore();
    flaky.saveTimeline = async () => {
      throw new Error('db timeout');
    };
    await expect(new PipelineRunner(cfg, flaky, undefined, { tts: () => tts }).run({ ...job, settings: para })).rejects.toBeTruthy();
    // Back to sentence highlighting: must not trust the paragraph timeline on disk.
    const again = await runJob(job);
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg.storage.output, 'tl', 'timeline.json'), 'utf8')) as Timeline;
    expect(again.r.timeline).toEqual(onDisk);
    const fresh = await runJob({ ...job, projectId: 'tl-fresh' });
    expect(onDisk.segments.map((s) => s.rects)).toEqual(fresh.r.timeline.segments.map((s) => s.rects));
  }, 120_000);
});

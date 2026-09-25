import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { resolveSettings, type VoiceInfo } from '@app/types';
import { MemoryStore, PipelineRunner, probe, run, type TTSProvider, type TTSResult, type TTSSegment, type TTSOptions } from '../src';

const cfgBase = loadConfig();
const hasPython = fs.existsSync(cfgBase.PYTHON_BIN);
let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

/** Deterministic fake TTS: 0.08 s per word of silence, written as FLAC via ffmpeg. */
class FakeTTS implements TTSProvider {
  readonly engine = 'fake';
  readonly version = 'fake-v1';
  calls = 0;
  failOnce = false;
  async isAvailable() {
    return { ok: true, message: 'ready' };
  }
  async listVoices(): Promise<VoiceInfo[]> {
    return [];
  }
  async synthesize(): Promise<TTSResult> {
    throw new Error('not used');
  }
  async synthesizeSegments(segments: TTSSegment[], o: TTSOptions & { onProgress?: (p: { done: number; total: number }) => void }): Promise<TTSResult> {
    this.calls++;
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('synthetic engine crash');
    }
    let t = 0;
    const sentences = segments.map((s, i) => {
      const start = t;
      t += 0.08 * s.text.split(/\s+/).length;
      const end = t;
      t += s.pauseMs / 1000;
      o.onProgress?.({ done: i + 1, total: segments.length });
      return { id: s.id, start, end };
    });
    const samples = Math.round(t * o.sampleRate);
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${o.sampleRate}:cl=mono`, '-t', String(samples / o.sampleRate), '-c:a', 'flac', o.outPath]);
    return { audioPath: o.outPath, durationSec: samples / o.sampleRate, sampleRate: o.sampleRate, samples, sentences };
  }
}

describe.skipIf(!hasPython || !hasFfmpeg)('pipeline integration (python + ffmpeg)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-it-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, KEEP_INTERMEDIATE: false as never, VIDEO_BITRATE: '1M' }, { reload: true });
  const pdf = path.join(tmp, 'sample.pdf');
  const tts = new FakeTTS();
  const settings = resolveSettings({
    tts: { engine: 'kokoro', voice: 'af_heart', speed: 1 },
    video: { width: 320, height: 180, fps: 10 },
    text: { useLlm: false },
  });
  const job = { projectId: 'p1', pdfPath: pdf, pdfHash: 'samplehash', title: 'Sample', settings };

  beforeAll(() => {
    execFileSync(cfg.PYTHON_BIN, ['-m', 'audiobook_worker.sample', pdf, '--chapters', '2', '--paras', '3'], {
      env: { ...process.env, PYTHONPATH: cfg.workerDir },
    });
  });

  it('produces a synced mp4, m4a and srt', async () => {
    const store = new MemoryStore();
    const r = await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job);
    expect(r.analysis.chapters.map((c) => c.title)).toEqual(['Opening Pages', 'Chapter 1: The Beginning', 'Chapter 2: Steam and Iron']);
    const names = r.outputs.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['audiobook.mp4', 'audiobook.m4a', 'subtitles.srt']));
    const mp4 = r.outputs.find((o) => o.name === 'audiobook.mp4')!.path;
    const p = await probe(cfg, mp4);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    const a = p.streams.find((s) => s.codec_type === 'audio')!;
    expect(v.width).toBe(320);
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.25);
    expect(Math.abs(Number(a.duration) - r.durationSec)).toBeLessThan(0.3);
    expect(p.streams.some((s) => s.codec_type === 'subtitle')).toBe(true);
    expect(store.steps.every((s) => s.status === 'COMPLETED')).toBe(true);
    // intermediates cleaned, outputs kept
    expect(fs.existsSync(path.join(cfg.storage.renders, 'pages', 'samplehash'))).toBe(false);
  }, 180_000);

  it('resumes without redoing any finished work', async () => {
    const before = tts.calls;
    const store = new MemoryStore();
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job);
    expect(tts.calls).toBe(before);
    expect(store.steps.filter((s) => s.status === 'COMPLETED').every((s) => s.cached)).toBe(true);
  }, 120_000);

  it('changing the video theme re-renders video only', async () => {
    const before = tts.calls;
    const store = new MemoryStore();
    const themed = { ...job, settings: { ...settings, video: { ...settings.video, theme: 'dark' as const } } };
    await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(themed);
    expect(tts.calls).toBe(before);
    const st = Object.fromEntries(store.steps.map((s) => [s.key, s]));
    expect(st.EXTRACT.cached).toBe(true);
    expect(st.ANALYZE.cached).toBe(true);
    expect(st.TTS_CHAPTER_1.cached).toBe(true);
    expect(st.VIDEO_CHAPTER_1.cached).toBe(false);
  }, 180_000);

  it('failed chapter keeps finished chapters; retry continues', async () => {
    const voiced = { ...job, projectId: 'p2', settings: { ...settings, outputMode: 'audiobook_only' as const, tts: { ...settings.tts, voice: 'am_adam' } } };
    tts.failOnce = true;
    const s1 = new MemoryStore();
    const orig = cfg.MAX_CONCURRENT_TTS;
    (cfg as { MAX_CONCURRENT_TTS: number }).MAX_CONCURRENT_TTS = 1;
    try {
      await expect(new PipelineRunner(cfg, s1, undefined, { tts: () => tts }).run(voiced)).rejects.toMatchObject({ code: 'TTS_FAILED' });
      const failed = s1.steps.find((s) => s.status === 'FAILED')!;
      expect(failed.key).toBe('TTS_CHAPTER_1');
      expect(failed.error?.message).toBe('Audio generation failed for Chapter 1.');
      const s2 = new MemoryStore();
      const before = tts.calls;
      await new PipelineRunner(cfg, s2, undefined, { tts: () => tts }).run(voiced);
      const st = Object.fromEntries(s2.steps.map((s) => [s.key, s]));
      expect(st.EXTRACT.cached).toBe(true); // voice change never redoes PDF work
      expect(st.ANALYZE.cached).toBe(true);
      expect(tts.calls - before).toBe(3); // all 3 chapters (first failed before any finished)
      expect(st.VIDEO_CHAPTER_1).toBeUndefined();
    } finally {
      (cfg as { MAX_CONCURRENT_TTS: number }).MAX_CONCURRENT_TTS = orig;
    }
  }, 120_000);

  it('builds TTS chunks with paragraph/chapter pauses', () => {
    const c = {
      index: 0,
      title: 't',
      pageStart: 1,
      pageEnd: 1,
      source: 'pattern' as const,
      paragraphs: [
        { id: 'p0', index: 0, kind: 'heading' as const, text: '', pageStart: 1, pageEnd: 1, regions: [], sentences: [{ id: 'a', index: 0, text: 'H', narration: 'H.', regions: [] }] },
        { id: 'p1', index: 1, kind: 'body' as const, text: '', pageStart: 1, pageEnd: 1, regions: [], sentences: [{ id: 'b', index: 1, text: 'x', narration: 'x', regions: [] }, { id: 'c', index: 2, text: 'y', narration: 'y', regions: [] }] },
      ],
    };
    const segs = PipelineRunner.chapterSegments(c, settings);
    expect(segs.map((s) => s.pauseMs)).toEqual([settings.audio.paragraphPauseMs + 250, settings.audio.sentencePauseMs, settings.audio.chapterPauseMs]);
  });
});

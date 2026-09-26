import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { resolveSettings } from '@app/types';
import { MemoryStore, PipelineRunner, run, type PipelineResult } from '../src';
import { FakeTTS, hasFfmpeg, samplePdf } from './runner-fakes';

/**
 * Long-book A/V sync: 35 chapters of an odd length (12.3456 s @ 24 kHz — not a whole
 * number of samples, frames or AAC packets). Each chapter is a tone after 0.6 s of
 * silence, so the real chapter onsets in the FINAL mp4's audio can be measured and
 * compared with the timeline the video/highlights are rendered from.
 */
const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);
const CHAPTER_SEC = 12.3456;
const LEAD = 0.6;
const FPS = 30;

interface Probed {
  streams: { codec_type: string; duration?: string; nb_frames?: string; start_time?: string }[];
  chapters: { start_time: string; end_time: string }[];
  format: { duration: string };
}
const ffprobe = async (file: string): Promise<Probed> =>
  JSON.parse(await run('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,duration,nb_frames,start_time:format=duration:chapter=start_time,end_time', '-of', 'json', file]));

/** Times (s) where the tone starts again after silence, measured on the decoded audio. */
function onsets(file: string): number[] {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'silencedetect=noise=-45dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' });
  return [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
}

describe.skipIf(!hasPython || !hasFfmpeg)('long-book A/V sync (35 odd-length chapters)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sync-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, VIDEO_BITRATE: '200k', MAX_CONCURRENT_PDF_RENDER: 3 }, { reload: true });
  const pdf = path.join(tmp, 'long.pdf');
  const tts = new FakeTTS({ chapterSec: CHAPTER_SEC, tone: true, leadSilenceSec: LEAD });
  const settings = resolveSettings({ video: { width: 128, height: 72, fps: FPS, animation: 'static', subtleZoom: false }, text: { useLlm: false } });
  let r: PipelineResult;
  let expectedStarts: number[] = [];

  beforeAll(async () => {
    samplePdf(cfg, pdf, 34, 1);
    r = await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts }).run({ projectId: 'long', pdfPath: pdf, pdfHash: 'longbook', title: 'Long', settings });
    const samples = Math.round(CHAPTER_SEC * cfg.TTS_SAMPLE_RATE);
    expectedStarts = r.timeline.chapters.map((_, i) => (i * samples) / cfg.TTS_SAMPLE_RATE);
  }, 900_000);

  it('timeline chapters are contiguous and sample-exact', () => {
    expect(r.timeline.chapters.length).toBe(35);
    const samples = Math.round(CHAPTER_SEC * cfg.TTS_SAMPLE_RATE);
    r.timeline.chapters.forEach((c, i) => {
      expect(c.start).toBeCloseTo(expectedStarts[i], 9);
      if (i) expect(c.start).toBe(r.timeline.chapters[i - 1].end);
    });
    expect(r.durationSec).toBeCloseTo((35 * samples) / cfg.TTS_SAMPLE_RATE, 9);
  });

  it('mastered m4a keeps the exact length and chapter marks (loudnorm + aresample add no drift)', async () => {
    const m4a = path.join(cfg.storage.output, 'long', 'audiobook.m4a');
    const p = await ffprobe(m4a);
    const a = p.streams.find((s) => s.codec_type === 'audio')!;
    expect(Math.abs(Number(a.duration) - r.durationSec)).toBeLessThan(0.03); // < 1 AAC packet + rounding
    p.chapters.forEach((c, i) => expect(Math.abs(Number(c.start_time) - expectedStarts[i])).toBeLessThan(0.001));
    const on = onsets(m4a);
    expect(on.length).toBe(35);
    const err = on.map((t, i) => Math.abs(t - (expectedStarts[i] + LEAD)));
    expect(Math.max(...err)).toBeLessThan(1 / FPS);
  });

  it('final mp4: frame count, stream lengths and real chapter onsets stay within one frame', async () => {
    const mp4 = r.outputs.find((o) => o.name === 'audiobook.mp4')!.path;
    const p = await ffprobe(mp4);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    const a = p.streams.find((s) => s.codec_type === 'audio')!;
    expect(Number(v.nb_frames)).toBe(Math.round(r.durationSec * FPS));
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(1 / FPS + 0.025);
    expect(Math.abs(Number(a.duration) - r.durationSec)).toBeLessThan(0.03);
    expect(Number(a.start_time ?? 0)).toBeCloseTo(0, 3);
    expect(Number(v.start_time ?? 0)).toBeCloseTo(0, 3);
    // Every chapter's video frames begin where its audio begins (frame rounding only).
    r.timeline.chapters.forEach((c, i) => expect(Math.abs(Math.round(c.start * FPS) / FPS - expectedStarts[i])).toBeLessThanOrEqual(0.5 / FPS + 1e-9));
    const on = onsets(mp4);
    expect(on.length).toBe(35);
    const drift = on.map((t, i) => t - (expectedStarts[i] + LEAD));
    expect(Math.max(...drift.map(Math.abs))).toBeLessThan(1 / FPS);
  });
});

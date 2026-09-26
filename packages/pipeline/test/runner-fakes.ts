import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '@app/config';
import type { VoiceInfo } from '@app/types';
import { CancelledError } from '@app/shared';
import { run, type TTSOptions, type TTSProvider, type TTSResult, type TTSSegment } from '../src';

export const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export interface FakeTTSOptions {
  /** Seconds of speech per word (default 0.08). */
  perWord?: number;
  /** Force every chapter to exactly this many seconds (odd durations for drift tests). */
  chapterSec?: number;
  /** Write a sine tone instead of silence (so loudnorm has something to work on). */
  tone?: boolean;
  /** Milliseconds to wait before writing (lets tests abort mid-chapter). */
  delayMs?: number;
  /** With `tone`: seconds of silence at the start of every chapter (onset markers for sync checks). */
  leadSilenceSec?: number;
}

/**
 * Deterministic stand-in for Kokoro: exact sample counts, sentence timings from word
 * counts, audio written atomically as FLAC through ffmpeg.
 */
export class FakeTTS implements TTSProvider {
  readonly engine = 'fake';
  readonly version = 'fake-v1';
  calls = 0;
  failOn?: (segments: TTSSegment[]) => boolean;
  constructor(private readonly o: FakeTTSOptions = {}) {}
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
    if (this.failOn?.(segments)) throw new Error('synthetic engine crash');
    const perWord = this.o.perWord ?? 0.08;
    const raw = segments.reduce((n, s) => n + perWord * s.text.split(/\s+/).length + s.pauseMs / 1000, 0);
    const scale = this.o.chapterSec ? this.o.chapterSec / raw : 1;
    let t = 0;
    const sentences = segments.map((s, i) => {
      const start = t;
      t += perWord * s.text.split(/\s+/).length * scale;
      const end = t;
      t += (s.pauseMs / 1000) * scale;
      o.onProgress?.({ done: i + 1, total: segments.length });
      return { id: s.id, start, end };
    });
    const samples = Math.round((this.o.chapterSec ?? t) * o.sampleRate);
    if (this.o.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.o.delayMs);
        o.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new CancelledError())), { once: true });
      });
    }
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
    const tmp = `${o.outPath}.${process.pid}.${this.calls}.tmp.flac`;
    // aevalsrc is evaluated per sample, so the lead-in silence ends exactly on its sample.
    const src = this.o.tone
      ? `aevalsrc='if(lt(t,${this.o.leadSilenceSec ?? 0}),0,0.5*sin(2*PI*220*t))':s=${o.sampleRate}`
      : `anullsrc=r=${o.sampleRate}:cl=mono`;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-af', `atrim=end_sample=${samples}`, '-ac', '1', '-c:a', 'flac', tmp], { signal: o.signal });
    fs.renameSync(tmp, o.outPath);
    return { audioPath: o.outPath, durationSec: samples / o.sampleRate, sampleRate: o.sampleRate, samples, sentences };
  }
}

/** Build a sample book PDF with the Python sample generator. */
export function samplePdf(cfg: AppConfig, out: string, chapters: number, paras: number): string {
  execFileSync(cfg.PYTHON_BIN, ['-m', 'audiobook_worker.sample', out, '--chapters', String(chapters), '--paras', String(paras)], {
    env: { ...process.env, PYTHONPATH: cfg.workerDir },
  });
  return out;
}

/** Container/stream tags via ffprobe. */
export async function probeTags(cfg: AppConfig, file: string): Promise<Record<string, string>> {
  const out = await run(cfg.FFPROBE_BIN, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file]);
  return (JSON.parse(out) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
}

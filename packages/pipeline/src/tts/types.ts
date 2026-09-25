import type { SentenceTiming, VoiceInfo } from '@app/types';
import type { ProgressEvent } from '../python/bridge';

export interface TTSOptions {
  voice: string;
  /** 0.5 .. 2.0 */
  speed: number;
  language: string;
  sampleRate: number;
  /** Where to write the audio. */
  outPath: string;
  signal?: AbortSignal;
}

export interface TTSResult {
  /** Audio file on disk (never kept in memory). */
  audioPath: string;
  durationSec: number;
  sampleRate: number;
  samples: number;
  /** Sentence timestamps (seconds). Present for segment synthesis. */
  sentences?: SentenceTiming[];
  /** Word timestamps — estimated from sentence timing when the engine has none. */
  words?: { t: string; start: number; end: number }[];
}

export interface TTSSegment {
  id: string;
  text: string;
  /** Silence after this segment. */
  pauseMs: number;
}

export interface TTSProvider {
  readonly engine: string;
  /** Bumped when output for the same input would change (part of cache keys). */
  readonly version: string;
  isAvailable(): Promise<{ ok: boolean; message: string }>;
  listVoices(): Promise<VoiceInfo[]>;
  synthesize(text: string, options: TTSOptions): Promise<TTSResult>;
  /**
   * Synthesize many segments into ONE file with exact per-segment timings.
   * This is what the pipeline uses per chapter: timing comes from sample counts, so the
   * highlight sync is exact without forced alignment.
   */
  synthesizeSegments(segments: TTSSegment[], options: TTSOptions & { wordTimings?: boolean; onProgress?: (p: ProgressEvent) => void }): Promise<TTSResult>;
}

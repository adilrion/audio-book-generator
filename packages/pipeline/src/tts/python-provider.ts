import type { VoiceInfo } from '@app/types';
import type { ProgressEvent, PythonPool } from '../python/bridge';
import type { TTSOptions, TTSProvider, TTSResult, TTSSegment } from './types';

interface PyChapterResult {
  path: string;
  sampleRate: number;
  samples: number;
  duration: number;
  timings?: { id: string; start: number; end: number; words?: { t: string; start: number; end: number }[] }[];
}

/** TTS engines implemented in the Python worker (Kokoro, Piper, macOS say). */
export class PythonTTSProvider implements TTSProvider {
  readonly version = 'py-tts-v1';

  constructor(
    readonly engine: 'kokoro' | 'piper' | 'say',
    private readonly pool: PythonPool,
  ) {}

  async isAvailable(): Promise<{ ok: boolean; message: string }> {
    const status = await this.pool.call<Record<string, { available: boolean; message: string }>>('tts.engines', {});
    const s = status[this.engine];
    return { ok: !!s?.available, message: s?.message ?? 'unknown engine' };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const r = await this.pool.call<{ available: boolean; voices: { id: string; name: string; language: string; gender?: string }[] }>('tts.voices', {
      engine: this.engine,
    });
    return r.voices.map((v) => ({
      id: v.id,
      name: v.name,
      engine: this.engine,
      language: v.language,
      gender: (v.gender as VoiceInfo['gender']) ?? undefined,
      installed: true,
    }));
  }

  async synthesize(text: string, o: TTSOptions): Promise<TTSResult> {
    const r = await this.pool.call<PyChapterResult>(
      'tts.synthesize',
      { engine: this.engine, text, voice: o.voice, speed: o.speed, language: o.language, sampleRate: o.sampleRate, outPath: o.outPath },
      { signal: o.signal },
    );
    return { audioPath: r.path, durationSec: r.duration, sampleRate: r.sampleRate, samples: r.samples };
  }

  async synthesizeSegments(
    segments: TTSSegment[],
    o: TTSOptions & { wordTimings?: boolean; onProgress?: (p: ProgressEvent) => void },
  ): Promise<TTSResult> {
    const r = await this.pool.call<PyChapterResult>(
      'tts.synthesize_chapter',
      {
        engine: this.engine,
        segments,
        voice: o.voice,
        speed: o.speed,
        language: o.language,
        sampleRate: o.sampleRate,
        outPath: o.outPath,
        wordTimings: !!o.wordTimings,
      },
      { signal: o.signal, onProgress: o.onProgress },
    );
    const timings = r.timings ?? [];
    return {
      audioPath: r.path,
      durationSec: r.duration,
      sampleRate: r.sampleRate,
      samples: r.samples,
      sentences: timings.map(({ id, start, end, words }) => ({ id, start, end, words })),
      words: timings.flatMap((t) => t.words ?? []),
    };
  }
}

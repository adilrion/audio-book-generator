import fsp from 'node:fs/promises';
import type { AppConfig } from '@app/config';
import type { ShortVoiceFx } from '@app/types';
import { run } from './ffmpeg';

/**
 * Voice tones for Shorts, applied when the narration is mastered (the cached narration stays
 * natural, so changing the tone does not narrate again). The pitch goes down by resampling and the
 * tempo is put back exactly, so the narration keeps its length and the captions stay in sync:
 *
 *  - deep: about two semitones lower, warmer lows, gently compressed;
 *  - powerful: about three and a half semitones lower, a strong low end, presence for clarity,
 *    heavier compression and a short room echo — the "deep motivation" sound.
 */
const TONES: Record<Exclude<ShortVoiceFx, 'natural'>, { pitch: number; colour: string[] }> = {
  deep: {
    pitch: 0.88,
    colour: ['bass=g=4:f=120:w=0.6', 'acompressor=threshold=0.125:ratio=3:attack=8:release=150:makeup=1.6'],
  },
  powerful: {
    pitch: 0.82,
    colour: [
      'bass=g=6:f=110:w=0.7',
      'equalizer=f=2600:t=q:w=1.2:g=2',
      'acompressor=threshold=0.1:ratio=4:attack=6:release=180:makeup=2',
      'aecho=0.85:0.75:40|85:0.2|0.1',
    ],
  },
};

const RATE = 48000;

/** The ffmpeg audio filters for a tone (undefined for the natural voice). */
export function voiceFxFilter(fx: ShortVoiceFx | undefined): string | undefined {
  if (!fx || fx === 'natural' || !(fx in TONES)) return undefined;
  const t = TONES[fx];
  return [`aresample=${RATE}`, `asetrate=${Math.round(RATE * t.pitch)}`, `aresample=${RATE}`, `atempo=${(1 / t.pitch).toFixed(6)}`, ...t.colour].join(',');
}

/** A copy of a WAV file in a tone (voice previews). */
export async function applyVoiceFx(cfg: AppConfig, inFile: string, outFile: string, fx: ShortVoiceFx, signal?: AbortSignal): Promise<void> {
  const filter = voiceFxFilter(fx);
  if (!filter) return fsp.copyFile(inFile, outFile);
  const tmp = `${outFile}.tmp.wav`;
  await run(cfg.FFMPEG_BIN, ['-hide_banner', '-y', '-nostats', '-i', inFile, '-af', filter, '-ac', '1', tmp], { signal });
  await fsp.rename(tmp, outFile);
}

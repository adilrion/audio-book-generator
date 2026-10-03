import fsp from 'node:fs/promises';
import type { AppConfig } from '@app/config';
import type { ShortVoiceFx } from '@app/types';
import { run } from './ffmpeg';

/**
 * Speaking styles for Shorts, applied when the narration is mastered. They aim for a person, not an
 * effect: the pitch goes down only about a semitone (more starts to sound processed — the voice's
 * own depth comes from choosing a deep voice, like Coach), with the tone of a close microphone
 * (warmth, less boom, presence) and no echo. The tempo is put back exactly, so the narration keeps
 * its length and the captions stay in sync; the pauses between sentences are longer (pauseScale).
 *
 *  - deep, "Warm storyteller": a little deeper and warmer, gently compressed;
 *  - powerful, "Motivational speaker": deeper, close and confident — a firmer low end, clear
 *    presence and broadcast compression.
 */
const TONES: Record<Exclude<ShortVoiceFx, 'natural'>, { pitch: number; colour: string[]; pauses: number }> = {
  deep: {
    pitch: 0.96,
    colour: ['equalizer=f=110:t=q:w=0.9:g=3', 'equalizer=f=320:t=q:w=1:g=-2', 'equalizer=f=3200:t=q:w=1.2:g=1.5', 'acompressor=threshold=0.2:ratio=2.2:attack=20:release=250:makeup=1.3'],
    pauses: 1.35,
  },
  powerful: {
    pitch: 0.95,
    colour: [
      'bass=g=3.5:f=140:w=0.6',
      'equalizer=f=300:t=q:w=1:g=-2.5',
      'equalizer=f=3000:t=q:w=0.9:g=3',
      'treble=g=1.5:f=9000:w=0.6',
      'deesser=i=0.3',
      'acompressor=threshold=0.14:ratio=3.2:attack=12:release=200:makeup=1.9:knee=4',
    ],
    pauses: 1.8,
  },
};

/** Bumped when a style's sound changes, so shorts made with the old sound are re-rendered. */
export const VOICE_FX_VERSION = 2;

/** How much longer the pauses between sentences are in a style (a speaker lets each line land). */
export const pauseScale = (fx: ShortVoiceFx | undefined): number => (fx && fx !== 'natural' && fx in TONES ? TONES[fx].pauses : 1);

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

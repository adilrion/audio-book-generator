import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { applyVoiceFx, pauseScale, voiceFxFilter } from '../src/audio/voice-fx';

const cfg = loadConfig();
const hasFfmpeg = (() => {
  try {
    execFileSync(cfg.FFMPEG_BIN, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-fx-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const probe = (file: string) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate', '-of', 'json', file], { encoding: 'utf8' })) as {
    format: { duration: string };
  };

/** The strongest frequency in a mono 16-bit WAV (a pure tone stays a pure tone after resampling). */
function peakHz(file: string): number {
  const raw = execFileSync(cfg.FFMPEG_BIN, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  const x = Array.from({ length: Math.min(8000, raw.length / 2) }, (_, i) => raw.readInt16LE(i * 2));
  let best = 0;
  let bestHz = 0;
  for (let hz = 60; hz <= 400; hz += 1) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < x.length; i++) {
      re += x[i] * Math.cos((2 * Math.PI * hz * i) / 8000);
      im += x[i] * Math.sin((2 * Math.PI * hz * i) / 8000);
    }
    if (re * re + im * im > best) [best, bestHz] = [re * re + im * im, hz];
  }
  return bestHz;
}

describe('voice tones', () => {
  it('lowers the pitch a little by resampling, puts the tempo back, and adds no echo', () => {
    expect(voiceFxFilter(undefined)).toBeUndefined();
    expect(voiceFxFilter('natural')).toBeUndefined();
    expect(voiceFxFilter('deep')).toMatch(/^aresample=48000,asetrate=46080,aresample=48000,atempo=1\.041667,equalizer=/);
    expect(voiceFxFilter('powerful')).toMatch(/^aresample=48000,asetrate=45600,aresample=48000,atempo=1\.052632,bass=/);
    expect(voiceFxFilter('powerful')).not.toMatch(/aecho|reverb/); // a person in a room, not an effect
  });

  it('gives the speaking styles longer pauses', () => {
    expect([pauseScale(undefined), pauseScale('natural'), pauseScale('deep'), pauseScale('powerful')]).toEqual([1, 1, 1.35, 1.8]);
  });

  it.skipIf(!hasFfmpeg)('keeps the length and drops the pitch', async () => {
    const src = path.join(tmp, 'tone.wav');
    execFileSync(cfg.FFMPEG_BIN, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=2:sample_rate=24000', src]);
    for (const [fx, factor] of [
      ['deep', 0.96],
      ['powerful', 0.95],
    ] as const) {
      const out = path.join(tmp, `${fx}.wav`);
      await applyVoiceFx(cfg, src, out, fx);
      expect(Math.abs(Number(probe(out).format.duration) - 2)).toBeLessThan(0.03);
      expect(Math.abs(peakHz(out) - 200 * factor)).toBeLessThanOrEqual(3);
    }
    const plain = path.join(tmp, 'natural.wav');
    await applyVoiceFx(cfg, src, plain, 'natural');
    expect(fs.readFileSync(plain).equals(fs.readFileSync(src))).toBe(true);
  });
});

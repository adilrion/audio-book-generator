import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../src/projects/settings.schema';

const issues = (input: unknown) => {
  const r = settingsSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('settingsSchema', () => {
  it('accepts an empty object (everything falls back to defaults)', () => {
    expect(settingsSchema.parse({})).toEqual({});
  });

  it('accepts valid partial settings and keeps only what was sent', () => {
    const input = {
      outputMode: 'audiobook_only',
      tts: { voice: 'af_sky' },
      text: { chapterRange: { from: 2, to: 2 } },
      video: { fps: 24, highlightColor: '#ff00AA', aspectRatio: '9:16' },
    };
    expect(settingsSchema.parse(input)).toEqual(input);
  });

  it('accepts chapterRange: null (used by PATCH to clear the range)', () => {
    expect(settingsSchema.parse({ text: { chapterRange: null } })).toEqual({ text: { chapterRange: null } });
  });

  it('accepts every engine and boundary values', () => {
    for (const engine of ['kokoro', 'piper', 'say'] as const) expect(issues({ tts: { engine } })).toEqual([]);
    expect(issues({ tts: { speed: 0.5 }, video: { fps: 10, width: 320, height: 3840 } })).toEqual([]);
    expect(issues({ tts: { speed: 2 }, video: { fps: 60 }, audio: { sentencePauseMs: 0, chapterPauseMs: 10_000 } })).toEqual([]);
  });

  it('strips unknown keys instead of storing them', () => {
    expect(settingsSchema.parse({ foo: 1, video: { fps: 30, bar: true } })).toEqual({ video: { fps: 30 } });
  });

  it.each([
    ['#FFF', 'short hex'],
    ['FFD54F', 'missing #'],
    ['#GGGGGG', 'non-hex digits'],
    ['red', 'named color'],
    ['#FFD54F00', 'with alpha'],
  ])('rejects highlightColor %s (%s)', (color) => {
    expect(issues({ video: { highlightColor: color } })).toEqual(['video.highlightColor']);
  });

  it.each([9, 61, 0, -30, 29.97, '30'])('rejects fps %s', (fps) => {
    expect(issues({ video: { fps } })).toEqual(['video.fps']);
  });

  it('rejects an unknown TTS engine', () => {
    expect(issues({ tts: { engine: 'elevenlabs' } })).toEqual(['tts.engine']);
  });

  it('rejects other invalid values with the right path', () => {
    expect(issues({ outputMode: 'podcast' })).toEqual(['outputMode']);
    expect(issues({ language: 'fr' })).toEqual(['language']);
    expect(issues({ tts: { voice: '' } })).toEqual(['tts.voice']);
    expect(issues({ tts: { speed: 3 } })).toEqual(['tts.speed']);
    expect(issues({ text: { chapterRange: { from: 0, to: 2 } } })).toEqual(['text.chapterRange.from']);
    expect(issues({ text: { chapterRange: { from: 1.5, to: 2 } } })).toEqual(['text.chapterRange.from']);
    expect(issues({ text: { ocr: 'maybe' } })).toEqual(['text.ocr']);
    expect(issues({ audio: { paragraphPauseMs: 5001 } })).toEqual(['audio.paragraphPauseMs']);
    expect(issues({ video: { width: 100 } })).toEqual(['video.width']);
    expect(issues({ video: { aspectRatio: '4:3' } })).toEqual(['video.aspectRatio']);
    expect(issues({ video: { theme: 'neon' } })).toEqual(['video.theme']);
  });

  it('rejects non-object input', () => {
    expect(settingsSchema.safeParse('{"fps":30}').success).toBe(false);
    expect(settingsSchema.safeParse(null).success).toBe(false);
    expect(settingsSchema.safeParse([]).success).toBe(false);
  });
});

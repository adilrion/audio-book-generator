import { DEFAULT_SETTINGS, type ProjectSettings, type Rect, type TimelineSegment } from '@app/types';
import { describe, expect, it } from 'vitest';
import { highlightFill, tintStyleCss } from '@/lib/highlight';
import { affectedStages, cloneSettings } from '@/lib/settings';
import { cursorAt, sameLine, wordIndexAt } from '@/lib/timeline';

/** One line, words of width 40 with 8pt gaps, each spoken for 0.5 s from t = 1. */
function segment(n = 4, y = 100): Pick<TimelineSegment, 'rects' | 'words'> {
  const words = Array.from({ length: n }, (_, i) => ({ start: 1 + i * 0.5, end: 1.5 + i * 0.5, rects: [[60 + i * 48, y, 100 + i * 48, y + 12]] as Rect[] }));
  return { rects: [[60, y, words.at(-1)!.rects[0][2], y + 12]], words };
}

describe('word and cursor timing (mirrors the video compositor)', () => {
  it('finds the word being spoken', () => {
    const w = segment().words!;
    expect(wordIndexAt(w, 0)).toBe(0);
    expect(wordIndexAt(w, 1.49)).toBe(0);
    expect(wordIndexAt(w, 1.5)).toBe(1);
    expect(wordIndexAt(w, 99)).toBe(3);
  });

  it('tells lines apart', () => {
    expect(sameLine([0, 100, 10, 112], [20, 101, 30, 113])).toBe(true);
    expect(sameLine([0, 100, 10, 112], [0, 115, 10, 127])).toBe(false);
  });

  it('sweeps the cursor continuously, including the space after each word', () => {
    const s = segment();
    const xs = Array.from({ length: 201 }, (_, i) => cursorAt(s, 1 + i * 0.01)!.x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
      expect(xs[i] - xs[i - 1]).toBeLessThan(3);
    }
    expect(xs[0]).toBe(60);
    expect(xs.at(-1)).toBe(s.rects[0][2]);
  });

  it('moves the cursor to the next printed line', () => {
    const s = segment(2);
    s.words!.push({ start: 2, end: 2.5, rects: [[60, 115, 120, 127]] });
    s.rects.push([60, 115, 120, 127]);
    expect(cursorAt(s, 1.9)!.line).toBe(0);
    expect(cursorAt(s, 2.25)).toEqual({ line: 1, x: 90 });
  });

  it('has no cursor without word timings', () => {
    expect(cursorAt({ rects: [[0, 0, 1, 1]] }, 1)).toBeUndefined();
  });
});

describe('highlight css', () => {
  it('tints faintly without fading the text', () => {
    for (const style of ['marker', 'underline', 'box'] as const) expect(tintStyleCss(style, '#FFD54F')).not.toHaveProperty('opacity');
    expect(tintStyleCss('marker', '#FFD54F').backgroundColor).toBe('#FFD54F4d');
  });

  it('draws the underline as a gradient that scales with the box', () => {
    expect(highlightFill('underline', '#FFD54F').background).toContain('linear-gradient');
    expect(highlightFill('marker', '#FFD54F')).toEqual({ backgroundColor: '#FFD54F', mixBlendMode: 'multiply' });
  });
});

describe('affectedStages for the new video options', () => {
  const s = (video: Partial<ProjectSettings['video']> = {}) => {
    const next = cloneSettings(DEFAULT_SETTINGS);
    Object.assign(next.video, video);
    return next;
  };

  it('re-times and re-renders for word / cursor highlighting', () => {
    expect(affectedStages({ video: { highlightMode: 'word' } }, s({ highlightMode: 'word' }))).toEqual(['TIMELINE', 'VIDEO', 'MUX']);
  });

  it('re-renders for page fit and frame changes', () => {
    expect(affectedStages({ video: { pageFit: 'text' } }, s({ pageFit: 'text' }))).toEqual(['VIDEO', 'MUX']);
    expect(affectedStages({ video: { frameStyle: 'solid' } }, s({ frameStyle: 'solid' }))).toEqual(['VIDEO', 'MUX']);
    expect(affectedStages({ video: { frameColor: '#000000' } }, s({ frameStyle: 'double', frameColor: '#000000' }))).toEqual(['VIDEO', 'MUX']);
  });

  it('ignores options that do nothing in the current mode', () => {
    expect(affectedStages({ video: { frameColor: '#000000', frameWidth: 40 } }, s({ frameColor: '#000000', frameWidth: 40 }))).toEqual([]);
    expect(affectedStages({ video: { sentenceTint: false } }, s({ sentenceTint: false }))).toEqual([]);
    expect(affectedStages({ video: { sentenceTint: false } }, s({ highlightMode: 'cursor', sentenceTint: false }))).toEqual(['VIDEO', 'MUX']);
  });
});

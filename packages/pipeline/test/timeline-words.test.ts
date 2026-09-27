import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Analysis, type ChapterAudio, type Rect, type Sentence, type WordBox } from '@app/types';
import { buildTimeline, estimateWordTimes, printedWordTimes, renderStyle, sentenceWordsByPage, speechWeight, wordBoxes } from '../src';

const box = (t: string, page: number, x: number, y = 100): WordBox => ({ t, parts: [{ page, rect: [x, y, x + t.length * 6, y + 12] }] });

function sentence(words: WordBox[], narration?: string): Sentence {
  const text = words.map((w) => w.t).join(' ');
  return { id: 's', index: 0, text, narration: narration ?? text, regions: [], words };
}

describe('word timing estimates', () => {
  it('weights words by spoken length and trailing punctuation', () => {
    expect(speechWeight('extraordinary')).toBeGreaterThan(speechWeight('a'));
    expect(speechWeight('word,')).toBeGreaterThan(speechWeight('word'));
    expect(speechWeight('word.')).toBeGreaterThan(speechWeight('word,'));
    expect(speechWeight('1920')).toBeGreaterThan(speechWeight('abcd'));
  });

  it('gives no pause to abbreviations, initials or the last word', () => {
    expect(speechWeight('Mr.')).toBe(speechWeight('Mr'));
    expect(speechWeight('J.')).toBe(speechWeight('J'));
    expect(speechWeight('end.', true)).toBe(speechWeight('end'));
  });

  it('fills the sentence exactly, contiguously and in order', () => {
    const w = estimateWordTimes(['The', 'quick', 'brown', 'fox.'], 2, 4);
    expect(w[0].start).toBe(2);
    expect(w.at(-1)!.end).toBe(4);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeCloseTo(w[i - 1].end, 9);
    expect(w[1].end - w[1].start).toBeGreaterThan(w[0].end - w[0].start);
  });

  it('maps printed words to the narration when it differs from the print', () => {
    // "e.g." is read as "for example": the printed word takes both spoken words' time
    const printed = ['Cotton,', 'e.g.', 'grew', 'fast.'];
    const spoken = [
      { t: 'Cotton,', start: 0, end: 1 },
      { t: 'for', start: 1, end: 1.4 },
      { t: 'example', start: 1.4, end: 2 },
      { t: 'grew', start: 2, end: 2.5 },
      { t: 'fast.', start: 2.5, end: 3 },
    ];
    const t = printedWordTimes(printed, 'Cotton, for example grew fast.', 0, 3, spoken);
    expect(t.map((w) => [w.start, w.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 2.5],
      [2.5, 3],
    ]);
  });

  it('gives a printed word that is not spoken (a footnote marker) no time', () => {
    const t = printedWordTimes(['Hello', '3', 'world.'], 'Hello world.', 0, 2);
    expect(t[1].end - t[1].start).toBeCloseTo(0, 6);
    expect(t[0].start).toBe(0);
    expect(t[2].end).toBe(2);
  });

  it('falls back to printed-word weights when nothing matches', () => {
    const t = printedWordTimes(['T', 'h', 'e'], 'The end.', 5, 6);
    expect(t[0].start).toBe(5);
    expect(t.at(-1)!.end).toBe(6);
  });
});

describe('timeline words', () => {
  it('splits a word hyphenated across pages between both pages', () => {
    const words = [box('Before', 1, 50), { t: 'workshops.', parts: [{ page: 1, rect: [100, 700, 160, 712] as Rect }, { page: 2, rect: [50, 60, 70, 72] as Rect }] }];
    const byPage = sentenceWordsByPage(sentence(words), { start: 0, end: 2 }, 10);
    expect([...byPage.keys()]).toEqual([1, 2]);
    const [p1, p2] = [byPage.get(1)!, byPage.get(2)!];
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(1);
    expect(p1[0].start).toBe(10);
    expect(p2[0].end).toBe(12);
    expect(p1[1].end).toBeCloseTo(p2[0].start, 3); // the page turns mid-word, where the print does
    expect(p1[1].end - p1[1].start).toBeGreaterThan(p2[0].end - p2[0].start); // by printed width
  });

  function analysis(): Analysis {
    const words = [box('One', 1, 50), box('two', 1, 80), box('three.', 1, 110)];
    return {
      version: 'v',
      language: 'en',
      title: 'T',
      lexicon: {},
      warnings: [],
      stats: { chapters: 1, paragraphs: 1, sentences: 1, words: 3, llmUsed: false, llmRepairs: 0, chapterSource: 'pattern' },
      cleaning: { removedHeaders: [], removedFooters: [], removedPageNumbers: 0, dehyphenated: 0, removedDuplicates: 0, removedTocLines: 0, bodyFontSize: 11 },
      chapters: [
        {
          index: 0,
          title: 'One',
          pageStart: 1,
          pageEnd: 1,
          source: 'pattern',
          paragraphs: [
            {
              id: 'c0-p0',
              index: 0,
              kind: 'body',
              text: 'One two three.',
              pageStart: 1,
              pageEnd: 1,
              regions: [{ page: 1, rects: [[50, 100, 146, 112]], chars: 14 }],
              sentences: [{ ...sentence(words), id: 'a', regions: [{ page: 1, rects: [[50, 100, 146, 112]], chars: 14 }] }],
            },
          ],
        },
      ],
    };
  }
  const audios: ChapterAudio[] = [{ chapterIndex: 0, file: 'a', sampleRate: 24000, samples: 24000 * 4, durationSec: 4, cacheKey: 'k', engine: 'fake', voice: 'v', timings: [{ id: 'a', start: 0.5, end: 2.5 }] }];

  it('adds words only for word and cursor highlighting', () => {
    for (const mode of ['sentence', 'paragraph'] as const) expect(buildTimeline(analysis(), audios, { fps: 30, highlightMode: mode, pageSizes: {} }).segments[0].words).toBeUndefined();
    for (const mode of ['word', 'cursor'] as const) {
      const seg = buildTimeline(analysis(), audios, { fps: 30, highlightMode: mode, pageSizes: {} }).segments[0];
      expect(seg.words!.map((w) => w.rects[0][0])).toEqual([50, 80, 110]);
      expect(seg.words![0].start).toBe(0.5);
      expect(seg.words!.at(-1)!.end).toBe(2.5);
      expect([seg.start, seg.end]).toEqual([0.5, 2.5]);
    }
  });

  it('records printed word boxes from tokens', () => {
    const w = wordBoxes([{ t: 'work-shops', parts: [{ page: 3, b: [10.123, 20.456, 30.789, 40.01] }, { page: 4, b: [1, 2, 3, 4] }] }]);
    expect(w).toEqual([{ t: 'work-shops', parts: [{ page: 3, rect: [10.1, 20.5, 30.8, 40] }, { page: 4, rect: [1, 2, 3, 4] }] }]);
  });
});

describe('renderStyle', () => {
  it('keeps the v1 style (and so existing render cache keys) for default settings', () => {
    expect(Object.keys(renderStyle(DEFAULT_SETTINGS.video)).sort()).toEqual(['animation', 'highlightColor', 'highlightStyle', 'showChapterTitle', 'showProgress', 'subtleZoom', 'theme']);
  });

  it('includes the new options once they are used', () => {
    const v = { ...DEFAULT_SETTINGS.video, highlightMode: 'cursor' as const, pageFit: 'text' as const, frameStyle: 'double' as const };
    expect(renderStyle(v)).toMatchObject({ highlightMode: 'cursor', sentenceTint: true, pageFit: 'text', frameStyle: 'double', frameColor: '#1F2937', frameWidth: 24, frameRadius: 0 });
  });
});

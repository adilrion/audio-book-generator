import { describe, expect, it } from 'vitest';
import type { Analysis, ChapterAudio } from '@app/types';
import { buildCues, buildTimeline, chapterOffsets, segmentAt, splitAcrossPages, toSrt } from '../src';

function analysis(): Analysis {
  const s = (id: string, page: number | number[], text: string) => ({
    id,
    index: 0,
    text,
    narration: text,
    regions: (Array.isArray(page) ? page : [page]).map((p, i) => ({ page: p, rects: [[50, 100 + i * 20, 300, 112 + i * 20]] as [number, number, number, number][], chars: 10 * (i + 1) })),
  });
  return {
    version: 'v',
    language: 'en',
    title: 'T',
    lexicon: {},
    warnings: [],
    stats: { chapters: 2, paragraphs: 2, sentences: 3, words: 10, llmUsed: false, llmRepairs: 0, chapterSource: 'pattern' },
    cleaning: { removedHeaders: [], removedFooters: [], removedPageNumbers: 0, dehyphenated: 0, removedDuplicates: 0, removedTocLines: 0, bodyFontSize: 11 },
    chapters: [
      {
        index: 0,
        title: 'One',
        pageStart: 1,
        pageEnd: 2,
        source: 'pattern',
        paragraphs: [
          { id: 'c0-p0', index: 0, kind: 'body', text: '', pageStart: 1, pageEnd: 2, regions: [{ page: 1, rects: [[40, 90, 320, 160]], chars: 30 }, { page: 2, rects: [[40, 50, 320, 80]], chars: 20 }], sentences: [s('a', 1, 'First sentence.'), s('b', [1, 2], 'Second sentence crosses the page.')] },
        ],
      },
      { index: 1, title: 'Two', pageStart: 3, pageEnd: 3, source: 'pattern', paragraphs: [{ id: 'c1-p0', index: 0, kind: 'body', text: '', pageStart: 3, pageEnd: 3, regions: [], sentences: [s('c', 3, 'Third.')] }] },
    ],
  };
}

const audios: ChapterAudio[] = [
  { chapterIndex: 0, file: 'a', sampleRate: 24000, samples: 24000 * 10, durationSec: 10, cacheKey: 'k0', engine: 'fake', voice: 'v', timings: [{ id: 'a', start: 0, end: 3 }, { id: 'b', start: 3.3, end: 6.3 }] },
  { chapterIndex: 1, file: 'b', sampleRate: 24000, samples: 24000 * 5, durationSec: 5, cacheKey: 'k1', engine: 'fake', voice: 'v', timings: [{ id: 'c', start: 0.5, end: 2 }] },
];

describe('timeline', () => {
  it('offsets chapters by exact sample durations', () => {
    expect(chapterOffsets(audios)).toEqual([0, 10]);
  });

  it('computes global timestamps and chapter bounds', () => {
    const t = buildTimeline(analysis(), audios, { fps: 30, highlightMode: 'sentence', pageSizes: {} });
    expect(t.duration).toBe(15);
    expect(t.chapters.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [10, 15],
    ]);
    const c = t.segments.find((s) => s.sentenceId === 'c')!;
    expect(c.start).toBe(10.5);
    expect(c.end).toBe(12);
  });

  it('splits a cross-page sentence proportionally and flags page changes', () => {
    const t = buildTimeline(analysis(), audios, { fps: 30, highlightMode: 'sentence', pageSizes: {} });
    const b = t.segments.filter((s) => s.sentenceId === 'b');
    expect(b.map((s) => s.page)).toEqual([1, 2]);
    expect(b[0].start).toBe(3.3);
    expect(b[1].end).toBe(6.3);
    expect(b[0].end).toBeCloseTo(3.3 + 3 * (10 / 30), 4); // 10 of 30 chars on page 1
    expect(t.segments.map((s) => s.pageChange)).toEqual([true, false, true, true]);
  });

  it('uses sentence rectangles, or paragraph rectangles in paragraph mode', () => {
    const t1 = buildTimeline(analysis(), audios, { fps: 30, highlightMode: 'sentence', pageSizes: {} });
    expect(t1.segments[0].rects).toEqual([[50, 100, 300, 112]]);
    const t2 = buildTimeline(analysis(), audios, { fps: 30, highlightMode: 'paragraph', pageSizes: {} });
    expect(t2.segments[0].rects).toEqual([[40, 90, 320, 160]]);
  });

  it('finds the active segment by binary search', () => {
    const t = buildTimeline(analysis(), audios, { fps: 30, highlightMode: 'sentence', pageSizes: {} });
    expect(segmentAt(t.segments, 1)?.sentenceId).toBe('a');
    expect(segmentAt(t.segments, 3.31)?.sentenceId).toBe('b');
    expect(segmentAt(t.segments, 11)?.sentenceId).toBe('c');
    expect(segmentAt(t.segments, -1)).toBeUndefined();
  });

  it('keeps frame ranges contiguous across chapters (no A/V drift)', () => {
    const t = buildTimeline(analysis(), audios, { fps: 30, highlightMode: 'sentence', pageSizes: {} });
    const ranges = t.chapters.map((c) => [Math.round(c.start * 30), Math.round(c.end * 30)]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    expect(ranges[ranges.length - 1][1]).toBe(Math.round(t.duration * 30));
  });

  it('writes SRT cues', () => {
    const srt = toSrt(buildCues(analysis(), audios));
    expect(srt).toContain('00:00:10,500 --> 00:00:12,000');
    expect(srt.split('\n\n')).toHaveLength(3);
  });

  it('splitAcrossPages covers the whole interval', () => {
    const parts = splitAcrossPages([{ page: 1, rects: [], chars: 1 }, { page: 2, rects: [], chars: 3 }], 0, 4);
    expect(parts.map((p) => [p.start, p.end])).toEqual([
      [0, 1],
      [1, 4],
    ]);
  });
});

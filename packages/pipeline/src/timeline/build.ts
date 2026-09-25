import type { Analysis, ChapterAudio, HighlightMode, PageRegion, Sentence, Timeline, TimelineChapter, TimelineSegment } from '@app/types';

export const TIMELINE_VERSION = 'timeline-v1';

export interface SentenceRef {
  sentence: Sentence;
  paragraphRegions: PageRegion[];
  paragraphId: string;
  chapterIndex: number;
}

export function indexSentences(analysis: Analysis): Map<string, SentenceRef> {
  const map = new Map<string, SentenceRef>();
  for (const c of analysis.chapters)
    for (const p of c.paragraphs)
      for (const s of p.sentences) map.set(s.id, { sentence: s, paragraphRegions: p.regions, paragraphId: p.id, chapterIndex: c.index });
  return map;
}

/** Start time (global seconds) of each chapter = sum of previous chapter durations (sample-exact). */
export function chapterOffsets(audios: ChapterAudio[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const a of audios) {
    out.push(t);
    t += a.samples / a.sampleRate;
  }
  return out;
}

/**
 * Split one sentence's time across the pages it is printed on, proportionally to characters.
 * A sentence that starts at the bottom of page 41 and ends on page 42 highlights on both,
 * and the page turns when narration crosses the break.
 */
export function splitAcrossPages(regions: PageRegion[], start: number, end: number): { region: PageRegion; start: number; end: number }[] {
  const total = regions.reduce((n, r) => n + Math.max(1, r.chars), 0);
  let t = start;
  return regions.map((r, i) => {
    const d = ((end - start) * Math.max(1, r.chars)) / total;
    const seg = { region: r, start: t, end: i === regions.length - 1 ? end : t + d };
    t += d;
    return seg;
  });
}

export function buildTimeline(
  analysis: Analysis,
  audios: ChapterAudio[],
  opts: { fps: number; highlightMode: HighlightMode; pageSizes: Record<string, [number, number]> },
): Timeline {
  const refs = indexSentences(analysis);
  const offsets = chapterOffsets(audios);
  const segments: TimelineSegment[] = [];
  const chapters: TimelineChapter[] = [];
  let prevPage = -1;

  audios.forEach((a, ai) => {
    const off = offsets[ai];
    const ch = analysis.chapters.find((c) => c.index === a.chapterIndex)!;
    chapters.push({
      index: ch.index,
      title: ch.title,
      start: off,
      end: off + a.samples / a.sampleRate,
      pageStart: ch.pageStart,
      pageEnd: ch.pageEnd,
    });
    for (const t of a.timings) {
      const ref = refs.get(t.id);
      if (!ref || t.end <= t.start) continue;
      const regions = ref.sentence.regions.length ? ref.sentence.regions : ref.paragraphRegions;
      for (const part of splitAcrossPages(regions, off + t.start, off + t.end)) {
        const page = part.region.page;
        const rects =
          opts.highlightMode === 'paragraph'
            ? ref.paragraphRegions.find((r) => r.page === page)?.rects ?? part.region.rects
            : part.region.rects;
        segments.push({
          i: segments.length,
          sentenceId: t.id,
          paragraphId: ref.paragraphId,
          chapterIndex: ref.chapterIndex,
          page,
          start: round(part.start),
          end: round(part.end),
          text: ref.sentence.text,
          rects,
          pageChange: page !== prevPage,
        });
        prevPage = page;
      }
    }
  });

  const duration = chapters.length ? chapters[chapters.length - 1].end : 0;
  return { version: TIMELINE_VERSION, duration: round(duration), fps: opts.fps, pageSizes: opts.pageSizes, chapters, segments };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

/** Binary search: segment active at time t (last segment with start <= t). */
export function segmentAt(segments: TimelineSegment[], t: number): TimelineSegment | undefined {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? segments[ans] : undefined;
}

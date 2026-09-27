import type { Rect } from './pdf';

/** A printed word with the time it is spoken. Words are contiguous: each ends where the next begins. */
export interface TimelineWord {
  /** seconds, global */
  start: number;
  end: number;
  /** Where the word is printed on the segment's page, in reading order (two for a hyphenated word). */
  rects: Rect[];
}

export interface TimelineSegment {
  /** global order */
  i: number;
  sentenceId: string;
  paragraphId: string;
  chapterIndex: number;
  page: number;
  /** seconds, global */
  start: number;
  end: number;
  text: string;
  /** Rectangles to highlight on `page` (PDF points). */
  rects: Rect[];
  /** Segment begins on a different page than the previous segment. */
  pageChange: boolean;
  /** Word and cursor highlighting only: the segment's words with estimated speaking times. */
  words?: TimelineWord[];
}

export interface TimelineChapter {
  index: number;
  title: string;
  start: number;
  end: number;
  pageStart: number;
  pageEnd: number;
}

export interface Timeline {
  version: string;
  duration: number;
  fps: number;
  pageSizes: Record<string, [number, number]>;
  chapters: TimelineChapter[];
  segments: TimelineSegment[];
}

export interface SubtitleCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

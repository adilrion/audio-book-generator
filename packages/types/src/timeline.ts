import type { Rect } from './pdf';

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

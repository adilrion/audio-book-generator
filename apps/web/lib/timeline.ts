import type { Rect, Timeline, TimelineChapter, TimelineSegment } from '@app/types';

/**
 * Index of the segment being narrated at time `t`: the last segment whose start ≤ t.
 * During the short pause after a sentence the previous one stays highlighted (like the video).
 * Returns -1 before the first segment starts. O(log n) — called every animation frame.
 */
export function segmentIndexAt(segments: readonly Pick<TimelineSegment, 'start'>[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * `?t=` deep-link value → seconds: "83.5", "1:23", "1:02:03", "1m23s", "1h2m3s". Undefined when
 * missing or malformed. Takes the first value when the param is repeated.
 */
export function parseTimeParam(raw: string | string[] | undefined): number | undefined {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!v) return undefined;
  let sec: number | undefined;
  if (/^\d+(?:\.\d+)?$/.test(v)) sec = Number(v);
  else if (/^\d+(?::[0-5]\d){1,2}(?:\.\d+)?$/.test(v)) sec = v.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  else {
    const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
    if (m && (m[1] || m[2] || m[3])) sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return sec !== undefined && Number.isFinite(sec) ? sec : undefined;
}

/** Chapter containing time `t` (chapters are contiguous and sorted by start). */
export function chapterIndexAt(chapters: readonly Pick<TimelineChapter, 'start'>[], t: number): number {
  return Math.max(0, segmentIndexAt(chapters, t));
}

export interface PctRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * PDF-point rect (origin top-left) → percentage box relative to the page. Rendering the
 * overlay in % of a container that has the page's aspect ratio makes it scale exactly
 * with the displayed image at any size, with no measuring.
 */
export function rectToPercent(r: Rect, pageSize: [number, number], pad = 1.5): PctRect {
  const [w, h] = pageSize;
  const x0 = Math.max(0, Math.min(r[0], r[2]) - pad);
  const y0 = Math.max(0, Math.min(r[1], r[3]) - pad);
  const x1 = Math.min(w, Math.max(r[0], r[2]) + pad);
  const y1 = Math.min(h, Math.max(r[1], r[3]) + pad);
  return { left: (x0 / w) * 100, top: (y0 / h) * 100, width: (Math.max(0, x1 - x0) / w) * 100, height: (Math.max(0, y1 - y0) / h) * 100 };
}

export function pageSizeOf(timeline: Pick<Timeline, 'pageSizes'>, page: number): [number, number] {
  return timeline.pageSizes[String(page)] ?? timeline.pageSizes[String(1)] ?? [612, 792];
}

/** page → segment indices, for click-to-seek on the page image. */
export function segmentsByPage(segments: readonly TimelineSegment[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  segments.forEach((s, i) => {
    const list = map.get(s.page);
    if (list) list.push(i);
    else map.set(s.page, [i]);
  });
  return map;
}

/** Segment whose highlight rects contain point (x, y) in PDF points on `page`, or -1. */
export function hitTest(segments: readonly TimelineSegment[], indices: readonly number[] | undefined, x: number, y: number, slop = 3): number {
  if (!indices) return -1;
  for (const i of indices) {
    for (const r of segments[i].rects) {
      if (x >= Math.min(r[0], r[2]) - slop && x <= Math.max(r[0], r[2]) + slop && y >= Math.min(r[1], r[3]) - slop && y <= Math.max(r[1], r[3]) + slop) return i;
    }
  }
  return -1;
}

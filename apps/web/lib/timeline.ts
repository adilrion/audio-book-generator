import type { Rect, Timeline, TimelineChapter, TimelineSegment, TimelineWord } from '@app/types';

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

/** Word being spoken at `t` within a segment (the first word before the segment starts). */
export function wordIndexAt(words: readonly Pick<TimelineWord, 'start'>[], t: number): number {
  return Math.max(0, segmentIndexAt(words, t));
}

/** Two rects on the same printed line (vertical centres closer than half a line height). */
export function sameLine(a: Rect, b: Rect): boolean {
  return Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) < 0.5 * Math.max(a[3] - a[1], b[3] - b[1], 1e-6);
}

/** Index of the printed line (one of the segment's rects) that holds word rect `r`. */
function lineOf(lines: readonly Rect[], r: Rect): number {
  const cy = (r[1] + r[3]) / 2;
  let best = 0;
  let dist = Infinity;
  lines.forEach((ln, i) => {
    if (r[2] < ln[0] - 1 || r[0] > ln[2] + 1) return;
    const d = Math.abs((ln[1] + ln[3]) / 2 - cy);
    if (d < dist) [best, dist] = [i, d];
  });
  return best;
}

/**
 * Reading cursor at `t`: the printed line (index into `segment.rects`) and x (PDF points).
 * It sweeps each word, and the space after it, while the word is spoken — so it moves
 * continuously along a line. Mirrors cursor_position() in the video compositor.
 */
export function cursorAt(segment: Pick<TimelineSegment, 'rects' | 'words'>, t: number): { line: number; x: number } | undefined {
  const words = segment.words;
  const lines = segment.rects;
  if (!words?.length || !lines.length) return undefined;
  const k = wordIndexAt(words, t);
  const w = words[k];
  const rs = w.rects.map((r) => [...r] as Rect);
  const next = words[k + 1]?.rects[0];
  const last = rs[rs.length - 1];
  if (next && sameLine(last, next) && next[0] > last[2]) last[2] = next[0];
  const dur = w.end - w.start;
  const u = dur <= 0 ? 1 : Math.min(1, Math.max(0, (t - w.start) / dur));
  const widths = rs.map((r) => Math.max(1e-6, r[2] - r[0]));
  let pos = u * widths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < rs.length; i++) {
    if (pos <= widths[i] || i === rs.length - 1) {
      const line = lineOf(lines, rs[i]);
      const ln = lines[line];
      return { line, x: Math.min(ln[2], Math.max(ln[0], rs[i][0] + Math.min(pos, widths[i]))) };
    }
    pos -= widths[i];
  }
  return undefined;
}

import type { PageRegion, Rect } from '@app/types';
import type { Token } from './model';

/**
 * Turn the printed parts of a token range into per-page highlight regions:
 * one rectangle per (partial) printed line, so a sentence that starts mid-line
 * highlights exactly its own words.
 */
export function regionsFor(tokens: Token[]): PageRegion[] {
  const byPage = new Map<number, { rects: Rect[]; chars: number }>();
  for (const t of tokens) {
    const share = t.t.length / t.parts.length;
    for (const part of t.parts) {
      let pg = byPage.get(part.page);
      if (!pg) byPage.set(part.page, (pg = { rects: [], chars: 0 }));
      pg.chars += share;
      const r = part.b;
      const last = pg.rects[pg.rects.length - 1];
      const h = r[3] - r[1];
      const sameLine =
        last && Math.abs((last[1] + last[3]) / 2 - (r[1] + r[3]) / 2) < Math.max(2, h * 0.5) && r[0] >= last[0] - h && r[0] - last[2] < h * 3;
      if (sameLine) {
        last[0] = Math.min(last[0], r[0]);
        last[1] = Math.min(last[1], r[1]);
        last[2] = Math.max(last[2], r[2]);
        last[3] = Math.max(last[3], r[3]);
      } else {
        pg.rects.push([r[0], r[1], r[2], r[3]]);
      }
    }
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, v]) => ({
      page,
      rects: v.rects.map((r) => r.map((x) => Math.round(x * 100) / 100) as Rect),
      chars: Math.round(v.chars),
    }));
}

export function mergeRegions(regions: PageRegion[]): PageRegion[] {
  const map = new Map<number, PageRegion>();
  for (const r of regions) {
    const m = map.get(r.page);
    if (m) {
      m.rects.push(...r.rects);
      m.chars += r.chars;
    } else map.set(r.page, { page: r.page, rects: [...r.rects], chars: r.chars });
  }
  return [...map.values()].sort((a, b) => a.page - b.page);
}

import type { CleaningReport, ExtractedPage, Rect } from '@app/types';
import { type CleanPage, type Line, type Token } from './model';

const PAGE_NUMBER = /^[\s\-–—|•·]*[[{(]?(page\s+)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|\/)\s*\d{1,4})?[\]})]?[\s\-–—|•·]*$/i;
/** A bare (bracketed) number: "12", "{xii}", "[28]" — printed page references, line numbers, figure ticks. */
const NUMBER_ONLY = /^[[{(]?(\d{1,4}|[ivxlcdm]{1,7})[\]})]?$/i;
/** A drop cap: one big capital (optionally after an opening quote) or a lone opening quote. */
const DROP_CAP = /^(["'“‘(]?\p{Lu}|["'“‘])$/u;
const TOC_LEADER = /(\.\s*){4,}\s*\d{1,4}\s*$|(…\s*){2,}\s*\d{1,4}\s*$/;

function iou(a: Rect, b: Rect): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const u = area(a) + area(b) - inter;
  return u > 0 ? inter / u : 0;
}

/** "Chapter 3 — The Mill   47" → "chapter # the mill #" : identical across pages if it's a running header */
export function headerKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\b[ivxlcdm]{1,7}\b/g, '#')
    .replace(/[^\p{L}#]+/gu, ' ')
    .trim();
}

export function bodyFontSize(pages: CleanPage[]): number {
  const weight = new Map<number, number>();
  for (const p of pages)
    for (const l of p.lines) {
      const k = Math.round(l.size * 2) / 2;
      weight.set(k, (weight.get(k) ?? 0) + l.text.length);
    }
  let best = 11;
  let bw = -1;
  for (const [k, w] of weight) if (w > bw) [best, bw] = [k, w];
  return best;
}

export function toCleanPages(pages: ExtractedPage[]): { pages: CleanPage[]; removedDuplicates: number } {
  let removedDuplicates = 0;
  const out: CleanPage[] = [];
  for (const p of pages) {
    const lines: Line[] = [];
    p.blocks.forEach((blk, bi) => {
      for (const ln of blk.lines) {
        const tokens: Token[] = [];
        for (const w of ln.words) {
          const prev = tokens[tokens.length - 1];
          // overprinted "fake bold" duplicates the same word at the same place
          if (prev && prev.t === w.t && iou(prev.parts[0].b, w.b) > 0.7) {
            removedDuplicates++;
            continue;
          }
          const t = w.t.replace(/\u00ad(?!$)/g, '').replace(/[\u200b\ufeff]/g, ''); // keep a final soft hyphen: it marks a sure join
          if (t) tokens.push({ t, parts: [{ page: p.page, b: w.b }] });
        }
        if (!tokens.length) continue;
        const line: Line = {
          page: p.page,
          block: bi,
          b: ln.b,
          size: ln.size,
          bold: ln.bold,
          italic: ln.italic,
          tokens,
          text: tokens.map((t) => t.t).join(' '),
        };
        const dup = lines.find((o) => o.text === line.text && iou(o.b, line.b) > 0.7);
        if (dup) {
          removedDuplicates++;
          continue;
        }
        lines.push(line);
      }
    });
    out.push({ page: p.page, width: p.width, height: p.height, lines });
  }
  return { pages: out, removedDuplicates };
}

/**
 * Join a drop cap ("I" printed large, "T is a truth…" beside it) to the first word of the line it drops into.
 * Otherwise the letter is lost (it looks like a page number "I" in the top margin) or read as its own heading.
 */
export function mergeDropCaps(p: CleanPage, body: number): number {
  let merged = 0;
  const caps = p.lines.filter((l) => l.tokens.length === 1 && l.size >= body * 1.6 && DROP_CAP.test(l.text));
  for (const cap of caps) {
    const h = cap.b[3] - cap.b[1];
    let best: Line | undefined;
    let bestD = Infinity;
    for (const l of p.lines) {
      if (l === cap || Math.abs(l.size - body) > body * 0.2) continue;
      const dx = l.b[0] - cap.b[2];
      const dy = l.b[1] - cap.b[1];
      if (dx < -body * 0.3 || dx > body * 1.5 || dy < -body * 0.6 || dy > h * 0.5) continue;
      if (Math.abs(dx) + Math.abs(dy) < bestD) [best, bestD] = [l, Math.abs(dx) + Math.abs(dy)];
    }
    if (!best || !/^[\p{L}"'“‘]/u.test(best.tokens[0].t)) continue;
    const first = best.tokens[0];
    best.tokens[0] = { t: cap.text + first.t, parts: [...cap.tokens[0].parts, ...first.parts] };
    best.text = best.tokens.map((t) => t.t).join(' ');
    p.lines = p.lines.filter((l) => l !== cap);
    merged++;
  }
  return merged;
}

/**
 * Remove running headers/footers, page numbers and TOC leader lines.
 * Deterministic and position-aware: only lines in the top/bottom margin zones are candidates.
 */
export function cleanPages(extracted: ExtractedPage[]): { pages: CleanPage[]; report: CleaningReport } {
  const { pages, removedDuplicates } = toCleanPages(extracted);
  const body = bodyFontSize(pages);
  const n = pages.length;
  for (const p of pages) mergeDropCaps(p, body);

  const zoneOf = (p: CleanPage, l: Line): 'top' | 'bottom' | null => {
    const zone = Math.max(36, p.height * 0.09);
    if (l.b[3] <= zone) return 'top';
    if (l.b[1] >= p.height - zone) return 'bottom';
    return null;
  };

  const counts = new Map<string, Set<number>>();
  for (const p of pages)
    for (const l of p.lines) {
      const z = zoneOf(p, l);
      if (!z) continue;
      const key = `${z}|${headerKey(l.text)}`;
      if (!counts.has(key)) counts.set(key, new Set());
      counts.get(key)!.add(p.page);
    }

  const strong = n <= 4 ? 2 : Math.max(3, Math.ceil(n * 0.2));
  const removedHeaders = new Set<string>();
  const removedFooters = new Set<string>();
  let removedPageNumbers = 0;
  let removedTocLines = 0;

  for (const p of pages) {
    p.lines = p.lines.filter((l) => {
      if (TOC_LEADER.test(l.text)) {
        removedTocLines++;
        return false;
      }
      if (NUMBER_ONLY.test(l.text) && l.size <= body * 0.85) {
        removedPageNumbers++; // small page references in the margin ("{28}"), wherever they are
        return false;
      }
      const z = zoneOf(p, l);
      if (!z) return true;
      if (PAGE_NUMBER.test(l.text) && l.size <= body * 1.15) {
        removedPageNumbers++;
        return false;
      }
      const key = headerKey(l.text);
      if (!key) return true;
      const c = counts.get(`${z}|${key}`)?.size ?? 0;
      const weak = c >= 3 && l.size <= body * 1.1 && l.tokens.length <= 12;
      if (c >= strong || weak) {
        (z === 'top' ? removedHeaders : removedFooters).add(l.text);
        return false;
      }
      return true;
    });
  }

  return {
    pages,
    report: {
      removedHeaders: [...removedHeaders].slice(0, 20),
      removedFooters: [...removedFooters].slice(0, 20),
      removedPageNumbers,
      dehyphenated: 0,
      removedDuplicates,
      removedTocLines,
      bodyFontSize: body,
    },
  };
}

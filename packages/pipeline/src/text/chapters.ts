import type { ChapterSource, TocEntry } from '@app/types';
import type { RawParagraph } from './paragraphs';

const NUM_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
const NUMBER = `(\\d{1,3}|[ivxlcdm]{1,7}|(?:${NUM_WORDS})(?:[\\s-](?:${NUM_WORDS}))?)`;

export const CHAPTER_PATTERNS: RegExp[] = [
  new RegExp(`^(chapter|chap\\.?|kapitel|chapitre|capítulo)\\s+${NUMBER}\\b`, 'i'),
  new RegExp(`^(part|book|section)\\s+${NUMBER}\\b`, 'i'),
  /^(prologue|epilogue|introduction|preface|foreword|afterword|conclusion|acknowledg(e)?ments|appendix(\s+[a-z0-9]+)?|interlude|postscript)\b/i,
  /^অধ্যায়\s*[০-৯\d]+/u, // Bangla "chapter N"
];
const NUMBERED_HEADING = /^(\d{1,2})(\.|\s|:)\s*\p{Lu}[^.!?]{1,80}$/u;
const FRONT_MATTER = /^(cover|title( page)?|copyright|contents|table of contents|dedication|also by|half title|about the author|praise for)\b/i;

export interface ChapterStart {
  paraIndex: number;
  title: string;
}

export interface ChapterDetection {
  starts: ChapterStart[];
  source: ChapterSource;
  /** Candidate headings the LLM may be asked to adjudicate. */
  candidates: { id: number; text: string; page: number; size: number }[];
  ambiguous: boolean;
}

export const paraText = (p: RawParagraph) => p.tokens.map((t) => t.t).join(' ');
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function isFrontMatterTitle(title: string): boolean {
  return FRONT_MATTER.test(title.trim());
}

function similarity(a: string, b: string): number {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Pick the TOC level that best represents chapters. */
export function chooseTocLevel(toc: TocEntry[]): number {
  const count = (lvl: number) => toc.filter((t) => t.level === lvl && t.page > 0).length;
  const l1 = count(1);
  const l2 = count(2);
  if (l1 < 3 && l2 >= 3) return 2;
  return 1;
}

function fromToc(paras: RawParagraph[], toc: TocEntry[]): ChapterStart[] {
  const level = chooseTocLevel(toc);
  const entries = toc.filter((t) => t.level === level && t.page > 0 && t.title.trim());
  const starts: ChapterStart[] = [];
  let from = 0;
  for (const e of entries) {
    let idx = -1;
    // 1) heading/short paragraph on that page matching the title
    for (let i = from; i < paras.length && paras[i].pageStart <= e.page; i++) {
      if (paras[i].pageStart === e.page && paras[i].tokens.length <= 25 && similarity(paraText(paras[i]), e.title) >= 0.6) {
        idx = i;
        break;
      }
    }
    // 2) first paragraph that starts on/after that page
    if (idx < 0) for (let i = from; i < paras.length; i++) if (paras[i].pageStart >= e.page) { idx = i; break; }
    if (idx < 0) continue;
    if (starts.length && starts[starts.length - 1].paraIndex === idx) continue;
    starts.push({ paraIndex: idx, title: e.title.trim() });
    from = idx + 1;
  }
  return starts;
}

function withSubtitle(paras: RawParagraph[], i: number): string {
  const t = paraText(paras[i]);
  const next = paras[i + 1];
  if (next && next.kind === 'heading' && next.pageStart === paras[i].pageStart && next.tokens.length <= 14 && !CHAPTER_PATTERNS.some((r) => r.test(paraText(next)))) {
    const sub = paraText(next);
    return /[:.—-]$/.test(t) ? `${t} ${sub}` : `${t}: ${sub}`;
  }
  return t;
}

export function detectChapters(paras: RawParagraph[], toc: TocEntry[], body: number): ChapterDetection {
  const candidates = paras
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.tokens.length <= 16 && (p.kind === 'heading' || p.size > body * 1.05))
    .map(({ p, i }) => ({ id: i, text: paraText(p).slice(0, 120), page: p.pageStart, size: p.size }));

  // 1) Embedded outline
  if (toc.filter((t) => t.page > 0).length >= 2) {
    const starts = fromToc(paras, toc);
    if (starts.length >= 2) return { starts, source: 'toc', candidates, ambiguous: false };
  }

  // 2) Textual patterns ("Chapter 3", "PART ONE", "Prologue") on heading-like lines
  const firstOnPage = new Set<number>();
  paras.forEach((p, i) => {
    if (i === 0 || paras[i - 1].pageEnd !== p.pageStart) firstOnPage.add(i);
  });
  const pattern: ChapterStart[] = [];
  paras.forEach((p, i) => {
    if (p.tokens.length > 16) return;
    const t = paraText(p);
    const headingish = p.kind === 'heading' || firstOnPage.has(i) || p.bold;
    const numbered = p.kind === 'heading' && NUMBERED_HEADING.test(t);
    if ((headingish && CHAPTER_PATTERNS.some((r) => r.test(t))) || numbered) {
      // "Chapter 1" + "The Beginning" subtitle → skip the subtitle as its own chapter
      const prev = pattern[pattern.length - 1];
      if (prev && prev.paraIndex === i - 1 && !CHAPTER_PATTERNS.some((r) => r.test(t))) return;
      pattern.push({ paraIndex: i, title: withSubtitle(paras, i) });
    }
  });
  const patternOk = pattern.length >= 2 && pattern.length <= Math.max(2, paras.length / 3);

  // 3) Font tiers: the largest heading size used more than once
  const tiers = new Map<number, number[]>();
  paras.forEach((p, i) => {
    if (p.kind !== 'heading' || p.tokens.length > 16) return;
    const k = Math.round(p.size);
    if (!tiers.has(k)) tiers.set(k, []);
    tiers.get(k)!.push(i);
  });
  const sizes = [...tiers.keys()].sort((a, b) => b - a);
  let font: ChapterStart[] = [];
  for (const s of sizes) {
    const idx = tiers.get(s)!;
    if (idx.length >= 2 && idx.length <= Math.max(2, paras.length / 4)) {
      font = idx.map((i) => ({ paraIndex: i, title: withSubtitle(paras, i) }));
      break;
    }
  }

  if (patternOk) {
    const ambiguous = font.length > 0 && Math.abs(font.length - pattern.length) > Math.max(3, pattern.length);
    return { starts: pattern, source: 'pattern', candidates, ambiguous };
  }
  if (font.length >= 2) {
    const ambiguous = font.length > 80 || candidates.length > 3 * font.length;
    return { starts: font, source: 'font', candidates, ambiguous };
  }
  return { starts: [], source: 'fallback', candidates, ambiguous: candidates.length >= 2 };
}

/** No structure found: cut into ~N-page sections at paragraph boundaries (keeps TTS/resume chunks small). */
export function fallbackSections(paras: RawParagraph[], pagesPerSection = 12): ChapterStart[] {
  if (!paras.length) return [];
  const starts: ChapterStart[] = [{ paraIndex: 0, title: 'Part 1' }];
  let nextPage = paras[0].pageStart + pagesPerSection;
  paras.forEach((p, i) => {
    if (i > 0 && p.pageStart >= nextPage && paras[i - 1].kind === 'body') {
      starts.push({ paraIndex: i, title: `Part ${starts.length + 1}` });
      nextPage = p.pageStart + pagesPerSection;
    }
  });
  return starts;
}

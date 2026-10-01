import type { ChapterSource, TocEntry } from '@app/types';
import { sectionTitle } from './bangla';
import type { RawParagraph } from './paragraphs';

const NUM_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
const NUMBER = `(\\d{1,3}|[ivxlcdm]{1,7}|(?:${NUM_WORDS})(?:[\\s-](?:${NUM_WORDS}))?)`;

// ── Bangla ──
// Patterns are NFC-normalized and matched against NFC text: NFC spells ড় ঢ় য় as letter + nukta,
// while PDFs print either form.
const bnRe = (src: string, flags = 'u') => new RegExp(src.normalize('NFC'), flags);
const BN_END = '(?![\\p{L}\\p{M}])';
/** অধ্যায় (chapter), পরিচ্ছেদ (chapter), পর্ব (part), খণ্ড (volume), ভাগ (part), সর্গ (canto), অঙ্ক (act) */
const BN_UNIT = '(?:অধ্যায়|পরিচ্ছেদ|পর্ব|খণ্ড|খন্ড|ভাগ|সর্গ|অঙ্ক|প্রকরণ)';
const BN_ORDINAL =
  '(?:প্রথম|দ্বিতীয়|তৃতীয়|চতুর্থ|পঞ্চম|ষষ্ঠ|সপ্তম|অষ্টম|নবম|দশম|একাদশ|দ্বাদশ|ত্রয়োদশ|চতুর্দশ|পঞ্চদশ|ষোড়শ|সপ্তদশ|অষ্টাদশ|ঊনবিংশ|বিংশ|একবিংশ|দ্বাবিংশ|ত্রয়োবিংশ|চতুর্বিংশ|পঞ্চবিংশ|শেষ)';
const BN_NUM_WORDS = '(?:এক|দুই|তিন|চার|পাঁচ|ছয়|সাত|আট|নয়|দশ|এগারো|বারো|তেরো|চোদ্দো|চৌদ্দ|পনেরো|ষোলো|সতেরো|আঠারো|উনিশ|বিশ)';
/** "৩", "3", "৩য়" (3rd), "১০ম", "এক" */
const BN_NUMBER = `(?:[০-৯\\d]{1,3}(?:ম|য়|র্থ|ষ্ঠ|শ|তম)?|${BN_NUM_WORDS}${BN_END})`;
/** "অধ্যায় ৩", "অধ্যায়-৩", "প্রথম অধ্যায়", "৩য় পরিচ্ছেদ" */
const BN_MARKER = `(?:${BN_UNIT}\\s*[-–—:ঃ]?\\s*${BN_NUMBER}|(?:${BN_ORDINAL}|${BN_NUMBER})\\s*${BN_UNIT}${BN_END})`;
const BN_NAMED = `(?:ভূমিকা|মুখবন্ধ|প্রস্তাবনা|প্রাক্কথন|প্রাককথন|উপক্রমণিকা|সূচনা|নিবেদন|লেখকের কথা|উপসংহার|পরিশিষ্ট|শেষকথা|শেষ কথা|পূর্বকথা|প্রসঙ্গকথা)${BN_END}`;

export const CHAPTER_PATTERNS: RegExp[] = [
  new RegExp(`^(chapter|chap\\.?|kapitel|chapitre|capítulo)\\s+${NUMBER}\\b`, 'i'),
  new RegExp(`^(part|book|section)\\s+${NUMBER}\\b`, 'i'),
  /^(prologue|epilogue|introduction|preface|foreword|afterword|conclusion|acknowledg(e)?ments|appendix(\s+[a-z0-9]+)?|interlude|postscript)\b/i,
  bnRe(`^${BN_MARKER}`),
  bnRe(`^${BN_NAMED}`),
];
const matchesChapterPattern = (t: string) => {
  const nfc = t.normalize('NFC');
  return CHAPTER_PATTERNS.some((r) => r.test(nfc));
};
/** A line that is nothing but a chapter marker ("CHAPTER III.", "Part Two", "Chapter 12:"). Strong evidence
 *  even at body size and without bold — many books typeset chapter labels like body text. */
// `chapter` may be glued to its number ("CHAPTERXXVII." from letter-spaced headings); part/book may not ("Parti").
export const CHAPTER_MARKER_LINE = new RegExp(`^((chapter|chap\\.?)\\s*|(part|book)\\s+)${NUMBER}\\s*[.:]?$`, 'i');
const BN_MARKER_LINE = bnRe(`^${BN_MARKER}\\s*[.:।]?$`);
export const isChapterMarkerLine = (text: string) => CHAPTER_MARKER_LINE.test(text.trim()) || BN_MARKER_LINE.test(text.trim().normalize('NFC'));

/** "1. Introduction", and in Bangla "১। ভূমিকা" / "২. শুরুর কথা" (no letter case to go by). */
const NUMBERED_HEADING = /^(\d{1,2})(\.|\s|:)\s*\p{Lu}[^.!?]{1,80}$|^([০-৯]{1,2}|\d{1,2})[.:।)]?\s*(?=\p{L})\p{Script=Bengali}[^।!?]{1,80}$/u;
const FRONT_MATTER = bnRe(
  '^(cover|title( page)?|copyright|contents|table of contents|dedication|also by|half title|about the author|praise for)\\b' +
    `|^(সূচিপত্র|সূচীপত্র|সূচি|সূচী|বিষয়সূচি|বিষয়সূচী|উৎসর্গ|প্রচ্ছদ|কৃতজ্ঞতা|কৃতজ্ঞতা স্বীকার|প্রকাশকের কথা|সর্বস্বত্ব|স্বত্ব)${BN_END}`,
  'iu',
);

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
// \p{M}: Bangla vowel signs are part of the word.
const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

const BACK_MATTER = bnRe(
  '^(index|general index|bibliography|about the (author|authors|translator|illustrator)|also by\\b|other (books|titles) by|colophon|(the )?full project gutenberg licen[sc]e|section \\d+\\.\\s.*project gutenberg|.*project gutenberg(-tm)? (licen[sc]e|literary archive)|licen[sc]e|reading group guide|a note on the type|praise for)' +
    // index, bibliography, references, about the author, other books by the author
    '|^(নির্ঘণ্ট|নির্ঘন্ট|গ্রন্থপঞ্জি|গ্রন্থপঞ্জী|গ্রন্থপঞ্জিকা|তথ্যসূত্র|সহায়ক গ্রন্থ|লেখক পরিচিতি|লেখক-পরিচিতি|লেখকের অন্যান্য|একই লেখকের|লেখকের আরও)',
  'iu',
);

/** Titles of chapters that are not part of the book's text proper when they come at the end. */
export function isBackMatterTitle(title: string): boolean {
  return BACK_MATTER.test(title.trim().normalize('NFC'));
}

export function isFrontMatterTitle(title: string): boolean {
  return FRONT_MATTER.test(title.trim().normalize('NFC'));
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
  if (next && next.kind === 'heading' && next.pageStart === paras[i].pageStart && next.tokens.length <= 14 && !matchesChapterPattern(paraText(next))) {
    const sub = paraText(next);
    return /[:.—\-ঃ।]$/.test(t) ? `${t} ${sub}` : `${t}: ${sub}`;
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
    const headingish = p.kind === 'heading' || firstOnPage.has(i) || p.bold || isChapterMarkerLine(t);
    const numbered = p.kind === 'heading' && NUMBERED_HEADING.test(t);
    if ((headingish && (isChapterMarkerLine(t) || matchesChapterPattern(t))) || numbered) {
      // "Chapter 1" + "The Beginning" subtitle → skip the subtitle as its own chapter
      const prev = pattern[pattern.length - 1];
      if (prev && prev.paraIndex === i - 1 && !isChapterMarkerLine(t) && !matchesChapterPattern(t)) return;
      pattern.push({ paraIndex: i, title: withSubtitle(paras, i) });
    }
  });
  // A contents page that lists bare markers ("Chapter I." / "Chapter II." …) is not a run of chapters:
  // drop runs of 3+ starts on one page with (almost) nothing between them.
  for (let k = 0; k < pattern.length; ) {
    let e = k;
    while (e + 1 < pattern.length && paras[pattern[e + 1].paraIndex].pageStart === paras[pattern[k].paraIndex].pageStart && pattern[e + 1].paraIndex - pattern[e].paraIndex <= 2) e++;
    if (e - k + 1 >= 3) pattern.splice(k, e - k + 1);
    else k = e + 1;
  }
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
export function fallbackSections(paras: RawParagraph[], pagesPerSection = 12, lang = 'en'): ChapterStart[] {
  if (!paras.length) return [];
  const starts: ChapterStart[] = [{ paraIndex: 0, title: sectionTitle('part', lang, 1) }];
  let nextPage = paras[0].pageStart + pagesPerSection;
  paras.forEach((p, i) => {
    if (i > 0 && p.pageStart >= nextPage && paras[i - 1].kind === 'body') {
      starts.push({ paraIndex: i, title: sectionTitle('part', lang, starts.length + 1) });
      nextPage = p.pageStart + pagesPerSection;
    }
  });
  return starts;
}

/** Sentence segmentation: ICU (Intl.Segmenter — works for Bangla too) + abbreviation repair + long-sentence splitting. */

const ABBREVIATIONS: Record<string, string[]> = {
  en: [
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'viz', 'al', 'inc',
    'ltd', 'co', 'corp', 'no', 'nos', 'vol', 'vols', 'fig', 'figs', 'p', 'pp', 'ch', 'chap', 'sec', 'ed', 'eds', 'rev',
    'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep', 'hon', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
    'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'a.m', 'p.m', 'approx', 'est', 'dept', 'univ', 'ave', 'blvd',
  ],
  bn: [],
};

/** Abbreviations that practically never end a sentence (merge even before a capital letter). */
const NEVER_TERMINAL = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'e.g', 'i.e', 'cf', 'viz', 'no', 'nos', 'vol',
  'vols', 'fig', 'figs', 'p', 'pp', 'ch', 'chap', 'sec', 'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep', 'hon',
]);

export const MAX_SENTENCE_CHARS = 320;

export interface Span {
  start: number;
  end: number;
}

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(lang: string): Intl.Segmenter {
  if (!segmenters.has(lang)) segmenters.set(lang, new Intl.Segmenter(lang, { granularity: 'sentence' }));
  return segmenters.get(lang)!;
}

/** 'strong' = never ends a sentence; 'weak' = ends one unless the next word is lowercase. */
function abbreviationAtEnd(s: string, lang: string): 'strong' | 'weak' | null {
  const m = /(?:^|[\s(\["'“‘])([\p{L}.]+)\.\s*$/u.exec(s.trimEnd());
  if (!m) return null;
  const w = m[1].toLowerCase().replace(/\.$/, '');
  if (/^\p{Lu}$/u.test(m[1])) return 'strong'; // initials: "J. R. R. Tolkien"
  if (lang === 'en' && NEVER_TERMINAL.has(w)) return 'strong';
  return (ABBREVIATIONS[lang] ?? ABBREVIATIONS.en).includes(w) ? 'weak' : null;
}

/** Split text into sentence character spans (trimmed, never empty). */
export function splitSentences(text: string, lang = 'en'): Span[] {
  const raw: Span[] = [];
  for (const seg of segmenter(lang).segment(text)) raw.push({ start: seg.index, end: seg.index + seg.segment.length });

  const merged: Span[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    const nextText = text.slice(s.start, s.end);
    if (prev) {
      const prevText = text.slice(prev.start, prev.end);
      const nextStartsLower = /^\s*[\p{Ll}\d]/u.test(nextText);
      const abbr = abbreviationAtEnd(prevText, lang);
      if (abbr && (abbr === 'strong' || nextStartsLower)) {
        prev.end = s.end;
        continue;
      }
      // Very short fragments ("1." or "“") belong to the neighbour.
      if (nextText.trim().length <= 2) {
        prev.end = s.end;
        continue;
      }
    }
    merged.push({ ...s });
  }

  const out: Span[] = [];
  for (const s of merged) for (const p of splitLong(text, s)) out.push(trim(text, p));
  return out.filter((s) => s.end > s.start && /[\p{L}\p{N}]/u.test(text.slice(s.start, s.end)));
}

function trim(text: string, s: Span): Span {
  let { start, end } = s;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** Break very long sentences at clause boundaries (; : — ,) nearest the middle. */
function splitLong(text: string, s: Span): Span[] {
  if (s.end - s.start <= MAX_SENTENCE_CHARS) return [s];
  const chunk = text.slice(s.start, s.end);
  const mid = chunk.length / 2;
  let best = -1;
  let bestScore = Infinity;
  const re = /[;:—–]\s|,\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) {
    const pos = m.index + m[0].length;
    const weight = m[0][0] === ',' ? 1.4 : 1; // prefer stronger breaks
    const score = Math.abs(pos - mid) * weight;
    if (pos > 40 && chunk.length - pos > 40 && score < bestScore) [best, bestScore] = [pos, score];
  }
  if (best < 0) {
    const sp = chunk.lastIndexOf(' ', Math.floor(mid));
    best = sp > 20 ? sp + 1 : Math.floor(mid);
  }
  return [...splitLong(text, { start: s.start, end: s.start + best }), ...splitLong(text, { start: s.start + best, end: s.end })];
}

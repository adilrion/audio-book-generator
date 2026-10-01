/**
 * Deterministic narration preparation. The printed text is never modified; this only
 * changes what the TTS engine is asked to say.
 */
import { isBangla, normalizeBanglaNarration } from './bangla';

const EN_REPLACEMENTS: [RegExp, string][] = [
  [/\be\.\s?g\.,?/gi, 'for example,'],
  [/\bi\.\s?e\.,?/gi, 'that is,'],
  [/\betc\./gi, 'et cetera.'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bcf\./gi, 'compare'],
  [/\bapprox\./gi, 'approximately'],
  [/\bNo\.\s?(?=\d)/g, 'number '],
  [/\bpp\.\s?(?=\d)/g, 'pages '],
  [/\bp\.\s?(?=\d)/g, 'page '],
  [/\bch\.\s?(?=\d)/gi, 'chapter '],
  [/\bfig\.\s?(?=\d)/gi, 'figure '],
  [/\s&\s/g, ' and '],
  [/%/g, ' percent'],
];

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
export function romanToInt(r: string): number | null {
  const s = r.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]];
    n += i + 1 < s.length && ROMAN[s[i + 1]] > v ? -v : v;
  }
  return n > 0 && n < 4000 ? n : null;
}

/** "CHAPTER XIII." → "Chapter 13." — TTS voices read roman numerals letter by letter. */
function chapterNumerals(s: string): string {
  return s.replace(/\b(?:(chapter)\s*|(chap\.|part|book|volume|vol\.|section|act|scene)\s+)([ivxlcdm]{1,7})\b/gi, (m, ch: string | undefined, other: string | undefined, num: string) => {
    const word = ch ?? other!;
    const n = romanToInt(num);
    if (n === null || (num.toUpperCase() !== num && num.toLowerCase() !== num)) return m;
    // "for my part I think" — a lone "I" after a lowercase keyword is the pronoun, not a numeral.
    if (num.toLowerCase() === 'i' && word[0] === word[0].toLowerCase()) return m;
    const w = word === word.toUpperCase() ? word[0] + word.slice(1).toLowerCase() : word;
    return `${w} ${n}`;
  });
}

export function normalizeNarration(text: string, lang: string, lexicon: Record<string, string> = {}): string {
  let s = text
    .replace(/[​﻿]/g, '')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\[[\d০-৯]{1,3}\]|(?<=[A-Za-z\u00C0-\u024F][.,;!?"'])\d{1,3}(?=\s|$)/g, '') // footnote markers: word.12 / [3]
    .replace(/https?:\/\/\S+/g, (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, ''))
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
  if (lang === 'en') {
    for (const [re, rep] of EN_REPLACEMENTS) s = s.replace(re, rep);
    s = chapterNumerals(s);
  }
  if (isBangla(lang)) s = normalizeBanglaNarration(s);
  for (const [word, say] of Object.entries(lexicon)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(?<![\\p{L}])${esc}(?![\\p{L}])`, 'gu'), say);
  }
  return s.replace(/,\s*,/g, ',').replace(/\s+([,.;:!?])/g, '$1').replace(/^,\s*/, '').trim();
}

/** Headings get a full stop (a danda in Bangla) so TTS uses falling (final) intonation. */
export function headingNarration(text: string, lang = 'en'): string {
  const t = text.trim();
  return /[.!?:।॥]$/.test(t) ? t : `${t}${isBangla(lang) ? '।' : '.'}`;
}

export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Deterministic narration preparation. The printed text is never modified; this only
 * changes what the TTS engine is asked to say.
 */
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

export function normalizeNarration(text: string, lang: string, lexicon: Record<string, string> = {}): string {
  let s = text
    .replace(/[​﻿]/g, '')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\[\d{1,3}\]|(?<=[A-Za-z\u00C0-\u024F][.,;!?"'])\d{1,3}(?=\s|$)/g, '') // footnote markers: word.12 / [3]
    .replace(/https?:\/\/\S+/g, (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, ''))
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
  if (lang === 'en') for (const [re, rep] of EN_REPLACEMENTS) s = s.replace(re, rep);
  for (const [word, say] of Object.entries(lexicon)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(?<![\\p{L}])${esc}(?![\\p{L}])`, 'gu'), say);
  }
  return s.replace(/,\s*,/g, ',').replace(/\s+([,.;:!?])/g, '$1').replace(/^,\s*/, '').trim();
}

/** Headings get a full stop so TTS uses falling (final) intonation. */
export function headingNarration(text: string): string {
  const t = text.trim();
  return /[.!?:]$/.test(t) ? t : `${t}.`;
}

export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

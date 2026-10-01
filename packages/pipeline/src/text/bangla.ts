/**
 * Bangla (Bengali script) rules: digits, repairs for damage typical of Bangla PDF text layers,
 * and the narration changes the Piper/espeak-ng Bangla voice needs. Pure functions.
 */

/** Bengali block: letters, vowel signs, digits, danda is separate (U+0964/U+0965, shared by Indic scripts). */
export const BENGALI = /\p{Script=Bengali}/u;
/** A dependent sign (vowel sign, hasanta, nukta, candrabindu, anusvara, visarga): never the first character of a word. */
export const BN_SIGN = /[ঁ-ঃ়া-্ৗ]/u;

const BN_ZERO = 0x09e6;
export const bnToAscii = (s: string) => s.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - BN_ZERO));
export const asciiToBn = (s: string | number) => String(s).replace(/\d/g, (d) => String.fromCharCode(BN_ZERO + Number(d)));

export const isBangla = (lang: string) => lang === 'bn';

/**
 * Repairs to a printed Bangla word that are always right, whatever produced the PDF:
 * - a dependent sign repeated ("অধ্যাায়", "শ্রীীকান্ত"): Chrome/Skia print a ligature whose ToUnicode
 *   entry already includes the vowel sign, and then the sign again. Two identical signs in a row
 *   never occur in Bangla text.
 */
export function repairBanglaWord(t: string): string {
  return t.replace(/([ঁ-ঃ়া-্ৗ])\1+/gu, '$1');
}

/** Words that start with a dependent sign ("িতীয়"): a lost conjunct or vowel signs in visual order. */
export function orphanSignWords(text: string): number {
  let n = 0;
  for (const w of text.split(/\s+/)) if (BN_SIGN.test(w.replace(/^[^\p{L}\p{M}]+/u, '')[0] ?? '')) n++;
  return n;
}

// ── narration ────────────────────────────────────────────────

/** Start of a word: JavaScript's \b only knows ASCII letters. */
const W = '(?<![\\p{L}\\p{M}])';
/** An abbreviation ends in a full stop, a visarga (ঃ) or a colon. */
const ABBR_END = '[.ঃ:]';

/** Spoken forms of common printed abbreviations. */
const BN_ABBREVIATIONS: [RegExp, string][] = [
  [new RegExp(`${W}ডা${ABBR_END}\\s*`, 'gu'), 'ডাক্তার '],
  [new RegExp(`${W}ড${ABBR_END}\\s*(?=\\p{Script=Bengali})`, 'gu'), 'ডক্টর '],
  [new RegExp(`${W}মো(?:হা)?${ABBR_END}\\s*`, 'gu'), 'মোহাম্মদ '],
  [new RegExp(`${W}মিঃ\\s*`, 'gu'), 'মিস্টার '],
  [new RegExp(`${W}মি\\.\\s*(?=\\p{Script=Bengali})`, 'gu'), 'মিস্টার '],
  [new RegExp(`${W}খ্রি(?:ষ্টাব্দ|স্টাব্দ)?${ABBR_END}`, 'gu'), 'খ্রিস্টাব্দ'],
  [new RegExp(`${W}খ্রিস্টপূর্ব${ABBR_END}`, 'gu'), 'খ্রিস্টপূর্ব'],
  [new RegExp(`${W}পৃ${ABBR_END}\\s*`, 'gu'), 'পৃষ্ঠা '],
  [new RegExp(`${W}বি${ABBR_END}\\s*দ্র${ABBR_END}`, 'gu'), 'বিশেষ দ্রষ্টব্য'],
  [new RegExp(`${W}লিঃ`, 'gu'), 'লিমিটেড'],
  [new RegExp(`${W}প্রাঃ`, 'gu'), 'প্রাইভেট'],
  [new RegExp(`${W}কোং`, 'gu'), 'কোম্পানি'],
  [new RegExp(`${W}নং(?![\\p{L}\\p{M}])`, 'gu'), 'নম্বর'],
  [new RegExp(`${W}ইং(?![\\p{L}\\p{M}])`, 'gu'), 'ইংরেজি'],
  // Honorifics after a name, printed in brackets: "মুহাম্মদ (সা.)".
  [/\(\s*সা[.ঃ]?\s*\)/gu, 'সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম'],
  [/\(\s*রা[.ঃ]?\s*\)/gu, 'রাদিয়াল্লাহু আনহু'],
  [/\(\s*আ[.ঃ]?\s*\)/gu, 'আলাইহিস সালাম'],
  [/\(\s*রহ[.ঃ]?\s*\)/gu, 'রহমাতুল্লাহি আলাইহি'],
];

const CENTURIES: Record<number, string> = { 11: 'এগারো', 12: 'বারো', 13: 'তেরো', 14: 'চোদ্দো', 15: 'পনেরো', 16: 'ষোলো', 17: 'সতেরো', 18: 'আঠারো', 19: 'উনিশ' };
const MONTHS =
  'জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর|বৈশাখ|জ্যৈষ্ঠ|আষাঢ়|শ্রাবণ|ভাদ্র|আশ্বিন|কার্তিক|অগ্রহায়ণ|পৌষ|মাঘ|ফাল্গুন|চৈত্র';
/** A four-digit year: before a year word ("১৯৭১ সালে", "১৪৩০ বঙ্গাব্দ") or after a month ("২৬ মার্চ, ১৯৭১"). */
const YEAR = new RegExp(
  `(?<![\\d০-৯])(?:(?<=(?:${MONTHS})[,\\s]+)([1১][1-9১-৯])([\\d০-৯]{2})|([1১][1-9১-৯])([\\d০-৯]{2})(?=\\s*(?:সাল|সন|খ্রি|ইং|বঙ্গাব্দ|শতাব্দ)))(?![\\d০-৯])`,
  'gu',
);

/** "১৯৭১" → "উনিশশো ৭১": a year is said in hundreds; the voice reads the rest as a number. */
function spokenYear(_m: string, a1?: string, b1?: string, a2?: string, b2?: string): string {
  const hundreds = CENTURIES[Number(bnToAscii(a1 ?? a2!))];
  const rest = Number(bnToAscii(b1 ?? b2!));
  return rest ? `${hundreds}শো ${asciiToBn(rest)}` : `${hundreds}শো`;
}

/**
 * Bangla narration rules (the printed text is never changed):
 * abbreviations spoken in full, years in hundreds, % and &, a visarga used as a colon
 * ("প্রশ্নঃ"), footnote numbers, and no full stop or joiner the voice would stumble on.
 */
export function normalizeBanglaNarration(s: string): string {
  let t = s.replace(/[‌‍]/g, ''); // ZWNJ/ZWJ only steer glyph shapes; espeak-ng reads "র‍্যাব" wrong with them
  for (const [re, rep] of BN_ABBREVIATIONS) t = t.replace(re, rep);
  t = t
    .replace(YEAR, spokenYear)
    .replace(/(?<=[\p{L}\p{M}][।,;!?"'”’)]?)[০-৯]{1,2}(?=\s|$)/gu, '') // footnote marker: "লিখেছিলেন।১"
    .replace(/\s*%/g, ' শতাংশ')
    .replace(/\s&\s/g, ' ও ')
    // Word-final visarga: an adverb ending ("সাধারণতঃ" → "সাধারণত") or a colon ("প্রশ্নঃ").
    .replace(/(?<=[তশ])ঃ(?=[\s,;:।!?]|$)/gu, '')
    .replace(/ঃ(?=\s|$)/gu, ':')
    // A full stop inside a sentence is an abbreviation or an initial ("এ. কে. ফজলুল হক"); the voice
    // would end the sentence there. Decimal points ("৩.৫") are left alone.
    .replace(/(?<=[\p{L}\p{M}])\.(?=\s+[^\s])/gu, '');
  return t;
}

/** Fallback chapter names in the book's language. */
export function sectionTitle(kind: 'opening' | 'part' | 'full', lang: string, n = 1): string {
  if (isBangla(lang)) return kind === 'opening' ? 'প্রারম্ভিক অংশ' : kind === 'part' ? `পর্ব ${asciiToBn(n)}` : 'সম্পূর্ণ বই';
  return kind === 'opening' ? 'Opening Pages' : kind === 'part' ? `Part ${n}` : 'Full Text';
}

/** The chapter the analyzer makes of everything before the first detected chapter. */
export const isOpeningPagesTitle = (title: string) => title === sectionTitle('opening', 'en') || title === sectionTitle('opening', 'bn');

import { type CleanPage, type Line } from './model';
import { romanToInt } from './normalize';

/** Distances (pt) of line centres from one page edge: where the book prints its page numbers. */
export interface FolioBand {
  lo: number;
  hi: number;
}

export interface FolioBands {
  top?: FolioBand;
  bottom?: FolioBand;
}

/** Page numbers never sit further inside the page than this share of its height. */
const MAX_BAND = 0.25;
/** Page numbers of one book line up within this many points. */
const BAND_WIDTH = 6;

function densest(distances: number[], min: number): FolioBand | undefined {
  if (distances.length < min) return undefined;
  const s = [...distances].sort((a, b) => a - b);
  let best: FolioBand | undefined;
  let bestN = 0;
  for (let i = 0, j = 0; i < s.length; i++) {
    while (s[i] - s[j] > BAND_WIDTH) j++;
    if (i - j + 1 > bestN) [best, bestN] = [{ lo: s[j], hi: s[i] }, i - j + 1];
  }
  return bestN >= min ? best : undefined;
}

/**
 * Where this book prints its page numbers. Most books keep them inside a 9 % margin, but ebook
 * layouts and scans often sit them well inside the page (The Metamorphosis prints "27" 70 pt above
 * the bottom of a 484 pt page, together with its running footer). Learned from the lines `isFolio`
 * accepts in the outer quarter of each page: a band a few points tall that holds one on at least
 * `minPages` pages.
 */
export function folioBands(pages: CleanPage[], isFolio: (l: Line) => boolean, minPages: number): FolioBands {
  const top: number[] = [];
  const bottom: number[] = [];
  for (const p of pages)
    for (const l of p.lines) {
      if (!isFolio(l)) continue;
      const c = (l.b[1] + l.b[3]) / 2;
      if (c <= p.height * MAX_BAND) top.push(c);
      else if (c >= p.height * (1 - MAX_BAND)) bottom.push(p.height - c);
    }
  return { top: densest(top, minPages), bottom: densest(bottom, minPages) };
}

/** The margin zone of a page edge: the default, widened to take in the book's page-number band. */
export function marginZone(p: CleanPage, band: FolioBand | undefined, body: number): number {
  const zone = Math.max(36, p.height * 0.09);
  return band ? Math.min(p.height * MAX_BAND, Math.max(zone, band.hi + body)) : zone;
}

/** The line sits at the height where this book prints its page numbers (a few points of slack). */
export function inFolioBand(p: CleanPage, l: Line, band: FolioBand | undefined, edge: 'top' | 'bottom'): boolean {
  if (!band) return false;
  const c = (l.b[1] + l.b[3]) / 2;
  const d = edge === 'top' ? c : p.height - c;
  return d >= band.lo - 3 && d <= band.hi + 3;
}

/**
 * OCR gives a line that starts with a drop cap the drop cap's height: "One morning, as Gregor…" comes
 * out at 14 pt in a 9 pt book and would be read as a heading, cut off from the rest of its sentence.
 * Such a line is long, and the next line starts inside it, indented beside the big letter.
 */
export function fixDropCapLines(p: CleanPage, body: number): number {
  let fixed = 0;
  for (const l of p.lines) {
    if (l.size < body * 1.18 || l.tokens.length < 5) continue;
    const beside = p.lines.some(
      (n) =>
        n !== l &&
        Math.abs(n.size - body) <= body * 0.2 &&
        n.b[1] > l.b[1] &&
        n.b[1] < l.b[3] - body * 0.4 && // starts inside the tall line
        n.b[0] >= l.b[0] + body && // indented beside the drop cap
        n.b[0] < l.b[0] + body * 6,
    );
    if (!beside) continue;
    l.size = body;
    fixed++;
  }
  return fixed;
}

const ROMAN_DIGITS: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function toRoman(n: number): string {
  let s = '';
  for (const [v, r] of ROMAN_DIGITS) for (; n >= v; n -= v) s += r;
  return s;
}

/** "I", "II.", "12", "§ 3", "- 4 -"; and the shapes OCR gives a roman numeral in a book face: "Ul", "Il" for II/III. */
const SECTION_NUMBER = /^[\s\-–—•·§#]*[[{(]?(?:[\d০-৯]{1,3}|([IVXLCDM]{1,7}|[ivxlcdm]{1,7})|([Il1|U]{1,4}))[\]})]?[.:]?[\s\-–—•·]*$/u;

/**
 * A paragraph that is nothing but a section or page number. Read aloud it is noise ("I." sounds like the
 * pronoun, "Ul." like nothing at all), so it is neither narrated nor highlighted; the chapter title keeps it.
 * A roman numeral must be well formed and below 400, so words like "MILD", "DID" or "mix" are not taken.
 */
export function isSectionNumber(text: string): boolean {
  const m = SECTION_NUMBER.exec(text.trim());
  if (!m) return false;
  if (m[1]) {
    const n = romanToInt(m[1]);
    return n !== null && n < 400 && toRoman(n) === m[1].toUpperCase();
  }
  if (m[2]) return /[Il1|]/.test(m[2]);
  return true;
}

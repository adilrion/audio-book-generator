import { type CleanPage, type Line, type Token, LOWER_START, TERMINAL, median, percentile } from './model';

export interface RawParagraph {
  kind: 'heading' | 'body';
  lines: Line[];
  tokens: Token[];
  size: number;
  bold: boolean;
  pageStart: number;
  pageEnd: number;
}

/** Hyphenated compounds whose hyphen must survive a line break ("self-" + "aware"). */
const COMPOUND_PREFIXES = new Set([
  'self', 'well', 'non', 'co', 'ex', 'all', 'half', 'cross', 'high', 'low', 'long', 'short', 'so', 'twenty', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'one', 'two', 'three', 'four', 'first', 'second', 'third',
  'mid', 'post', 'pre', 'anti', 'pro', 'semi', 'full', 'far', 'near', 'old', 'great', 'ill', 'quasi', 'vice', 'ever',
]);
/** Prefixes that are almost never a plain syllable break; the others ("ex-", "pro-", "co-") need a real word after them. */
const STRONG_PREFIXES = new Set([
  'self', 'well', 'half', 'ill', 'non', 'anti', 'semi', 'quasi', 'vice', 'cross', 'twenty', 'thirty', 'forty', 'fifty',
  'sixty', 'seventy', 'eighty', 'ninety',
]);

/** Line-final hyphen characters: ASCII hyphen-minus, U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN. */
const HYPHEN_END = /[-\u2010\u2011]$/;
const SOFT_HYPHEN = '\u00ad';
/** "Revolu-" at a line end (a hyphen right after a letter, any hyphen flavour). */
const BROKEN_END = /\p{L}[-\u2010\u2011\u00ad]$/u;

const wordKey = (s: string) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Words printed whole in the document. Line-break fragments ("com-" / "pleteness") are left out. */
export function buildVocabulary(pages: CleanPage[]): Set<string> {
  const v = new Set<string>();
  let prevBroken = false;
  for (const p of pages)
    for (const l of p.lines) {
      const last = l.tokens.length - 1;
      l.tokens.forEach((t, k) => {
        if ((k === 0 && prevBroken) || (k === last && BROKEN_END.test(t.t))) return;
        v.add(wordKey(t.t));
      });
      prevBroken = last >= 0 && BROKEN_END.test(l.tokens[last].t);
    }
  return v;
}

/**
 * Decide how to join "Revolu-" + "tion,". Returns the merged display text, or null if the
 * two tokens should stay separate words.
 *
 * `autoHyphen` is the character this document uses for automatic (discretionary) breaks when it
 * distinguishes them from real hyphens (Chrome/Skia print U+2010 for `hyphens: auto` and keep
 * U+002D for hyphens that are in the text). Then the decision is exact; otherwise the vocabulary decides.
 */
export function dehyphenate(a: string, b: string, vocab: Set<string>, autoHyphen?: string): string | null {
  const soft = a.endsWith(SOFT_HYPHEN);
  if (!(HYPHEN_END.test(a) || soft) || a.length < 2) return null;
  if (/^[-–—\u2010\u2011]+$/.test(a)) return null;
  const stem = a.slice(0, -1);
  if (!/\p{L}$/u.test(stem)) return null;
  if (soft) return stem + b;
  if (autoHyphen) return a.endsWith(autoHyphen) ? stem + b : `${stem}-${b}`;
  if (!LOWER_START.test(b)) return `${stem}-${b}`; // "anti-" + "American"
  const joined = wordKey(stem + b);
  const hyph = wordKey(`${stem}-${b}`);
  if (vocab.has(joined)) return stem + b;
  if (vocab.has(hyph)) return `${stem}-${b}`;
  const lastPart = wordKey(stem.split(/[-\u2010\u2011]/).pop() ?? stem);
  if (STRONG_PREFIXES.has(lastPart)) return `${stem}-${b}`;
  if (COMPOUND_PREFIXES.has(lastPart) && vocab.has(wordKey(b))) return `${stem}-${b}`;
  // Unknown: joining is the safer error for narration ("leavetaking" sounds right, "in cluded" does not).
  return stem + b;
}

/** U+2010 is this document's automatic-hyphenation mark if it ends several lines. */
function detectAutoHyphen(lines: Line[]): string | undefined {
  let n = 0;
  for (const l of lines) if (/\p{L}\u2010$/u.test(l.tokens[l.tokens.length - 1]?.t ?? '') && ++n >= 3) return '\u2010';
  return undefined;
}

interface PageStats {
  left: number;
  right: number;
  gap: number;
}

function pageStats(p: CleanPage, body: number): PageStats {
  const bodyLines = p.lines.filter((l) => Math.abs(l.size - body) <= 1);
  const src = bodyLines.length >= 3 ? bodyLines : p.lines;
  const gaps: number[] = [];
  for (let i = 1; i < src.length; i++) {
    const g = src[i].b[1] - src[i - 1].b[3];
    if (g > -body * 0.5 && g < body * 2) gaps.push(Math.max(0, g));
  }
  return {
    left: percentile(src.map((l) => l.b[0]), 10),
    right: percentile(src.map((l) => l.b[2]), 90),
    gap: gaps.length ? median(gaps) : body * 0.3,
  };
}

export function isHeadingLine(l: Line, body: number, bodyIsBold: boolean): boolean {
  if (l.size >= body * 1.18) return true;
  return l.bold && !bodyIsBold && l.tokens.length <= 14 && !/[,;]$/.test(l.text) && !TERMINAL.test(l.text);
}

/** Group cleaned lines into paragraphs using geometry (gaps, indents, short last lines) and fonts. */
export function buildParagraphs(pages: CleanPage[], body: number, vocab: Set<string>): { paragraphs: RawParagraph[]; dehyphenated: number } {
  const stats = new Map(pages.map((p) => [p.page, pageStats(p, body)]));
  const allLines = pages.flatMap((p) => p.lines);
  const boldChars = allLines.filter((l) => l.bold).reduce((s, l) => s + l.text.length, 0);
  const totalChars = allLines.reduce((s, l) => s + l.text.length, 0) || 1;
  const bodyIsBold = boldChars / totalChars > 0.5;
  const autoHyphen = detectAutoHyphen(allLines);

  const paragraphs: RawParagraph[] = [];
  let cur: RawParagraph | undefined;
  let prev: Line | undefined;
  let dehyphenated = 0;

  const startNew = (l: Line, kind: RawParagraph['kind']) => {
    cur = { kind, lines: [], tokens: [], size: l.size, bold: l.bold, pageStart: l.page, pageEnd: l.page };
    paragraphs.push(cur);
  };

  for (const l of allLines) {
    const heading = isHeadingLine(l, body, bodyIsBold);
    const kind: RawParagraph['kind'] = heading ? 'heading' : 'body';
    const st = stats.get(l.page)!;
    let split = !cur || !prev || cur.kind !== kind;

    if (!split && prev && cur) {
      const indent = l.b[0] - st.left;
      const indented = indent > body * 0.8 && indent < body * 8 && Math.abs(l.b[0] - prev.b[0]) > body * 0.5;
      const prevShort = prev.b[2] < st.right - body * 2.5;
      const prevEnds = TERMINAL.test(prev.text) || /[:"”]$/.test(prev.text);
      if (kind === 'heading') {
        split = Math.abs(l.size - cur.size) > 0.6 || l.page !== prev.page || l.b[1] - prev.b[3] > l.size * 1.6;
      } else if (l.page !== prev.page) {
        split = prevEnds && (indented || prevShort) && !LOWER_START.test(l.text);
      } else {
        const gap = l.b[1] - prev.b[3];
        const movedUp = l.b[1] < prev.b[1] - body; // new column
        if (movedUp) split = prevEnds && (indented || prevShort);
        else split = gap > st.gap + body * 0.45 || indented || (prevShort && prevEnds);
      }
    }

    if (split) startNew(l, kind);
    const p = cur!;
    const tokens = l.tokens.map((t) => ({ t: t.t, parts: [...t.parts] }));
    const last = p.tokens[p.tokens.length - 1];
    if (last && tokens.length) {
      const merged = dehyphenate(last.t, tokens[0].t, vocab, autoHyphen);
      if (merged !== null) {
        last.t = merged;
        last.parts.push(...tokens[0].parts);
        tokens.shift();
        dehyphenated++;
      }
    }
    p.tokens.push(...tokens);
    p.lines.push(l);
    p.pageEnd = l.page;
    prev = l;
  }
  return { paragraphs: paragraphs.filter((p) => p.tokens.length > 0), dehyphenated };
}

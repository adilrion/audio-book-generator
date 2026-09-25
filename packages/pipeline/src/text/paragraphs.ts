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

const wordKey = (s: string) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function buildVocabulary(pages: CleanPage[]): Set<string> {
  const v = new Set<string>();
  for (const p of pages) for (const l of p.lines) for (const t of l.tokens) v.add(wordKey(t.t));
  return v;
}

/**
 * Decide how to join "Revolu-" + "tion,". Returns the merged display text, or null if the
 * two tokens should stay separate words.
 */
export function dehyphenate(a: string, b: string, vocab: Set<string>): string | null {
  const soft = a.endsWith('­');
  if (!(a.endsWith('-') || soft) || a.length < 2) return null;
  if (/^[-–—]+$/.test(a)) return null;
  const stem = a.slice(0, -1);
  if (!/\p{L}$/u.test(stem)) return null;
  if (soft) return stem + b;
  if (!LOWER_START.test(b)) return `${stem}-${b}`; // "anti-" + "American"
  const joined = wordKey(stem + b);
  const hyph = wordKey(`${stem}-${b}`);
  if (vocab.has(joined)) return stem + b;
  if (vocab.has(hyph)) return `${stem}-${b}`;
  const lastPart = wordKey(stem.split('-').pop() ?? stem);
  if (COMPOUND_PREFIXES.has(lastPart)) return `${stem}-${b}`;
  return stem + b;
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
      const merged = dehyphenate(last.t, tokens[0].t, vocab);
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

import type { RawParagraph } from './paragraphs';

/** Word form with a trailing period kept ("mr." ≠ "or"), leading quotes and other trailing punctuation dropped. */
const formKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[,;:!?"'”’)\]]+$/u, '');

const OPENING = /^([“"'‘(]?)(\p{Lu}{1,11})(\.?)((?:['’][Ss])?[,;:!?”"’')]*)$/u;

export interface WordStats {
  /** occurrences of each form, any case */
  any: Map<string, number>;
  /** occurrences printed in lowercase (a real word, not an acronym) */
  lower: Map<string, number>;
  /** "form next-form" pairs (any case) */
  pairs: Map<string, number>;
}

export function wordStats(paras: RawParagraph[], skipFirstTokenOf: Set<number> = new Set()): WordStats {
  const any = new Map<string, number>();
  const lower = new Map<string, number>();
  const pairs = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  paras.forEach((p, pi) => {
    let prev = '';
    p.tokens.forEach((t, ti) => {
      // Section openings are exactly the words under suspicion; they must not vote for themselves.
      if (ti === 0 && skipFirstTokenOf.has(pi)) return;
      const k = formKey(t.t);
      if (!k) {
        prev = '';
        return;
      }
      bump(any, k);
      if (/^[^\p{L}]*\p{Ll}/u.test(t.t)) bump(lower, k);
      if (prev) bump(pairs, `${prev} ${k}`);
      prev = /[.!?]["'”’)]*$/.test(t.t) && !/^\p{Lu}\p{Ll}?\.$/u.test(t.t) ? '' : k.replace(/\.$/, '');
    });
  });
  return { any, lower, pairs };
}

/** Is paragraph i the opening of a section? A heading within the 3 preceding paragraphs, with only
 *  short paragraphs (illustration captions, "[Copyright …]") in between. */
function opensSection(paras: RawParagraph[], i: number): boolean {
  for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
    if (paras[k].kind === 'heading') return true;
    if (paras[k].tokens.length > 12) return false;
  }
  return false;
}

/**
 * Fix the first word of a section when a decorative initial was an image (not in the text layer)
 * or small caps shout the opening word:
 *   "OT all that Mrs. Bennet…"  → "Not all that…"   (missing letter chosen from the book's own words)
 *   "HE ladies of Longbourn…"   → "The ladies…"     ("the ladies" occurs in the book, "he ladies" doesn't)
 *   "R. BENNET’S property…"     → "MR. BENNET’S…"   (trailing period kept: "mr." beats "or")
 *   "IT is a truth…"            → "It is a truth…"  (small caps undone only for words printed lowercase elsewhere)
 * Candidates (the fragment itself, or one letter A–Z in front) are scored by how often they are
 * followed by the next word elsewhere in the book, then by how common they are.
 */
export function restoreSectionOpenings(paras: RawParagraph[]): number {
  const openings = new Set<number>();
  paras.forEach((p, i) => {
    if (p.kind === 'body' && p.tokens.length >= 2 && opensSection(paras, i) && OPENING.test(p.tokens[0].t)) openings.add(i);
  });
  if (!openings.size) return 0;
  const stats = wordStats(paras, openings);
  let fixed = 0;
  paras.forEach((p, i) => {
    if (!openings.has(i)) return;
    const tok = p.tokens[0];
    const m = OPENING.exec(tok.t)!;
    const [, lead, frag, dot, trail] = m;
    const next = p.tokens[1].t;
    const nextLower = /^[^\p{L}]*\p{Ll}/u.test(next);
    // "OT all" / "HEN Jane" → Titlecase; "R. BENNET’S" (small caps run on) → keep capitals
    const smallCapsRun = /^[^\p{L}]*\p{Lu}{2,}/u.test(next);
    if (!/^[^\p{L}]*\p{L}/u.test(next)) return;
    const nextKey = formKey(next).replace(/\.$/, '');
    // Score a reading by how often the book prints it before the same next word, then by frequency.
    const score = (w: string) => {
      const k = formKey(lead + w + dot + trail);
      return { bi: stats.pairs.get(`${k.replace(/\.$/, '')} ${nextKey}`) ?? 0, uni: stats.any.get(k) ?? 0 };
    };
    const better = (x: { bi: number; uni: number }, y: { bi: number; uni: number }) => x.bi > y.bi || (x.bi === y.bi && x.uni > y.uni);
    let best = frag;
    let bestS = score(frag);
    for (let c = 65; c <= 90; c++) {
      const cand = String.fromCharCode(c) + frag;
      const sc = score(cand);
      if (sc.uni >= 3 && better(sc, bestS)) [best, bestS] = [cand, sc]; // must be a real word of this book
    }
    const titled = (w: string) => w[0] + w.slice(1).toLowerCase();
    let out = best;
    if (!smallCapsRun && best.length >= 2) {
      // Undo small caps only for words the book also prints in lowercase (not acronyms like NATO).
      if (best !== frag || (stats.lower.get((frag + dot).toLowerCase()) ?? 0) >= 3) out = titled(best);
    }
    const t = lead + out + dot + (out !== best ? trail.replace(/['’]S/, (x) => x.toLowerCase()) : trail);
    if (t !== tok.t) {
      tok.t = t;
      fixed++;
    }
  });
  return fixed;
}

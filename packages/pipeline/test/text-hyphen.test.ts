import { describe, expect, it } from 'vitest';
import { buildParagraphs, buildVocabulary, cleanDocument, dehyphenate, paraText } from '../src';
import { page } from './fixtures';

// Regressions found on real Chrome/Skia-printed books (Project Gutenberg HTML → PDF with `hyphens: auto`).
const FULL = 'the quick brown fox jumps over the lazy dog and keeps running far away';

/** Justified lines at x=54 that all reach the right margin, one per string. */
const lines = (texts: string[], y0 = 100) => texts.map((text, i) => ({ text, x: 54, y: y0 + i * 15 }));

describe('line-break hyphens in real PDFs', () => {
  it('treats U+2010 HYPHEN like "-" (Chrome/Skia, InDesign emit it for automatic breaks)', () => {
    expect(dehyphenate('in‐', 'cluded', new Set())).toBe('included');
    expect(dehyphenate('com‐', 'pleteness,', new Set())).toBe('completeness,');
  });

  it('always joins a soft hyphen (U+00AD) from the extractor, even after a compound prefix', () => {
    const p = page(1, lines([`${FULL} self­`, 'ish people were there.']));
    const { pages } = cleanDocument([p]);
    const { paragraphs } = buildParagraphs(pages, 11, buildVocabulary(pages));
    expect(paraText(paragraphs[0])).toContain('selfish people');
  });

  it('builds the vocabulary without line-break fragments', () => {
    const p = page(1, lines([`${FULL} com-`, 'pleteness is a virtue of the long line text here.']));
    const { pages } = cleanDocument([p]);
    const v = buildVocabulary(pages);
    expect(v.has('com')).toBe(false);
    expect(v.has('pleteness')).toBe(false);
    expect(v.has('virtue')).toBe(true);
  });

  it('does not keep the hyphen of a weak prefix when the tail is not a word ("ex-posure")', () => {
    expect(dehyphenate('ex-', 'posure', new Set(['the']))).toBe('exposure');
    expect(dehyphenate('pro-', 'fess', new Set(['the']))).toBe('profess');
    // strong compound prefixes still keep it
    expect(dehyphenate('well-', 'known', new Set())).toBe('well-known');
  });

  it('keeps line-final ASCII hyphens as real hyphens when the PDF marks automatic breaks with U+2010', () => {
    const p = page(
      1,
      lines([
        `${FULL} un‐`,
        `derstood that ${FULL} in‐`,
        `cluded the ${FULL} al‐`,
        `lowance and a ${FULL} leave-`,
        `taking was an out-and-`,
        'out affair for all of them.',
      ]),
    );
    const { pages } = cleanDocument([p]);
    const { paragraphs } = buildParagraphs(pages, 11, buildVocabulary(pages));
    const text = paraText(paragraphs[0]);
    expect(text).toContain('understood');
    expect(text).toContain('included');
    expect(text).toContain('allowance');
    expect(text).toContain('leave-taking');
    expect(text).toContain('out-and-out');
  });

  it('keeps both printed boxes of a word joined across a U+2010 break', () => {
    const p = page(1, lines([`${FULL} Revolu‐`, 'tion changed the world.']));
    const { pages } = cleanDocument([p]);
    const { paragraphs, dehyphenated } = buildParagraphs(pages, 11, buildVocabulary(pages));
    expect(dehyphenated).toBe(1);
    const tok = paragraphs[0].tokens.find((t) => t.t === 'Revolution');
    expect(tok?.parts).toHaveLength(2);
  });
});

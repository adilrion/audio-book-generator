import { describe, expect, it } from 'vitest';
import type { ExtractionMeta } from '@app/types';
import { analyzeCleaned, buildParagraphs, buildVocabulary, cleanDocument, paraText } from '../src';
import { page } from './fixtures';

// Regressions found on real Chrome-printed Project Gutenberg books (Pride and Prejudice, 227–326 pages).
const FULL = 'the quick brown fox jumps over the lazy dog and keeps running far away';

function meta(pages: number): ExtractionMeta {
  return { pdfHash: 'x', extractorVersion: 'v', pageCount: pages, toc: [], wordCount: 1000, emptyPages: [], ocrPages: [], pagesFile: 'p', pageSizes: [] };
}

describe('drop caps', () => {
  it('joins a large initial letter to the first word instead of dropping it as a page number', () => {
    // "I" (30pt) at the top-left of the first chapter page, "T is a truth…" wraps around it.
    const p = page(1, [
      { text: 'I', x: 34, y: 27, size: 30 },
      { text: `T is a truth universally acknowledged, that ${FULL}`, x: 50, y: 29 },
      { text: 'wife.', x: 50, y: 44 },
      { text: `However little known the feelings of ${FULL}`, x: 56, y: 60 },
      { text: `${FULL} and the rest of it.`, x: 34, y: 75 },
    ]);
    const { pages } = cleanDocument([p]);
    const { paragraphs } = buildParagraphs(pages, 11, buildVocabulary(pages));
    expect(paraText(paragraphs[0]).startsWith('IT is a truth universally acknowledged')).toBe(true);
    const it0 = paragraphs[0].tokens[0];
    expect(it0.parts).toHaveLength(2); // highlight covers the big letter too
    expect(paragraphs).toHaveLength(2);
  });

  it('joins a drop cap that the PDF lists before the chapter heading', async () => {
    // Chrome emits the floated letter in its own block before the heading block.
    const pages = [
      page(1, [{ text: 'A Test Book', y: 200, size: 22 }]),
      page(2, [
        { text: 'I', x: 50, y: 437, size: 21 },
        { text: 'Chapter I.', x: 189, y: 416, size: 12.5 },
        { text: `T is a truth universally acknowledged, that ${FULL}`, x: 61, y: 438, size: 8.5 },
        { text: `tune must be in want of a wife and ${FULL}`, x: 61, y: 450, size: 8.5 },
        { text: `${FULL} and more of the same body text on this page.`, x: 50, y: 462, size: 8.5 },
      ]),
      page(3, [{ text: `${FULL} ${FULL} and then the chapter goes on.`, x: 50, y: 60, size: 8.5 }]),
    ];
    const a = await analyzeCleaned(cleanDocument(pages), meta(3), { language: 'en', skipFrontMatter: true });
    const ch = a.chapters.find((c) => c.title.startsWith('Chapter I'))!;
    expect(ch).toBeDefined();
    expect(ch.paragraphs.map((p) => p.text).join(' | ')).not.toMatch(/^I \|/);
    expect(ch.paragraphs[1].text.startsWith('IT is a truth')).toBe(true);
  });

  it('joins an opening-quote drop cap', () => {
    const p = page(1, [
      { text: '“', x: 34, y: 100, size: 30 },
      { text: `Oh! my dear, ${FULL}`, x: 50, y: 102 },
      { text: `${FULL} and so on.”`, x: 34, y: 117 },
    ]);
    const { pages } = cleanDocument([p]);
    const { paragraphs } = buildParagraphs(pages, 11, buildVocabulary(pages));
    expect(paraText(paragraphs[0]).startsWith('“Oh! my dear')).toBe(true);
  });
});

describe('page-reference markers and captions', () => {
  it('drops small bracketed page references printed in the margin, so paragraphs still join across pages', () => {
    // Gutenberg HTML prints the original edition's page numbers ("{28}") in a tiny font at the right edge.
    const p1 = page(1, [
      { text: `${FULL} and the story`, x: 34, y: 700 },
      { text: `${FULL} continues onto the`, x: 34, y: 715 },
      { text: '{28}', x: 556, y: 380, size: 6.8 },
    ], 612, 792);
    const p2 = page(2, [{ text: `next page without a break. ${FULL}.`, x: 34, y: 60 }], 612, 792);
    const { pages } = cleanDocument([p1, p2]);
    const { paragraphs } = buildParagraphs(pages, 11, buildVocabulary(pages));
    const all = paragraphs.map(paraText).join(' | ');
    expect(all).not.toContain('{28}');
    expect(all).toContain('continues onto the next page');
  });

  it('keeps a large chapter number at the top of a page (not a page number)', () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) =>
      page(n, [
        ...(n === 3 ? [{ text: '3', x: 200, y: 20, size: 36 }] : []),
        { text: `${FULL} body of page ${n}.`, x: 54, y: 200 },
        { text: String(n), x: 210, y: 620, size: 9 },
      ]),
    );
    const { pages: cleaned } = cleanDocument(pages);
    expect(cleaned[2].lines.map((l) => l.text)).toContain('3');
    expect(cleaned[3].lines.map((l) => l.text)).not.toContain('4');
  });

  it('starts a new paragraph when the font size changes (caption under an illustration)', () => {
    const p = page(1, [
      { text: `${FULL} and then`, x: 34, y: 100, size: 12 },
      { text: `${FULL} she said so`, x: 34, y: 114, size: 12 },
      { text: '“He came down to see the place”', x: 246, y: 128, size: 9 },
      { text: `that ${FULL} and the rest.`, x: 34, y: 140, size: 12 },
    ], 612, 792);
    const { pages } = cleanDocument([p]);
    const { paragraphs } = buildParagraphs(pages, 12, buildVocabulary(pages));
    expect(paragraphs.map(paraText)).toContain('“He came down to see the place”');
  });
});

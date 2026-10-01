import { describe, expect, it } from 'vitest';
import type { ExtractedPage, ExtractionMeta, TocEntry } from '@app/types';
import { analyzeCleaned, cleanDocument } from '../src';
import { isSectionNumber } from '../src/text/furniture';
import { type L, page } from './fixtures';

// Modelled on a scanned (OCR'd) ebook of The Metamorphosis: 322 × 484 pt pages, 9 pt body text, and the
// page number with a running footer 70 pt above the bottom edge — far outside the usual 9 % margin.
const W = 322;
const H = 484;
const LINE = 'he lay on his armour-hard back and saw his brown belly';

function meta(pages: number, toc: TocEntry[] = []): ExtractionMeta {
  return { pdfHash: 'x', extractorVersion: 'v', pageCount: pages, toc, wordCount: 1000, emptyPages: [], ocrPages: [], pagesFile: 'p', pageSizes: [] };
}

function scanPage(n: number, lines: L[], folio = String(n)): ExtractedPage {
  const footer: L[] =
    n % 2
      ? [{ text: 'FREE EBOOKS AT PLANET EBOOK.COM', x: 42, y: 413, size: 6.6 }, { text: folio, x: 275, y: 413, size: 5.5 }]
      : [{ text: folio, x: 41, y: 413, size: 5.5 }, { text: 'THE METAMORPHOSIS', x: 217, y: 413, size: 6.7 }];
  return page(n, [...lines, ...footer], W, H);
}

/** Body text that runs on from the previous page and on to the next one. */
function bodyPage(n: number, folio?: string): ExtractedPage {
  const lines: L[] = [{ text: `next page where sentence ${n} ends. Then ${LINE}`, x: 42, y: 60, size: 9 }];
  for (let i = 1; i < 12; i++) lines.push({ text: `${LINE} and`, x: 42, y: 60 + i * 12, size: 9 });
  lines.push({ text: 'the last line of this page runs on to the', x: 42, y: 60 + 12 * 12, size: 9 });
  return scanPage(n, lines, folio);
}

/** A chapter's first page: the section number, then a first line made tall by its OCR'd drop cap. */
function chapterPage(n: number, numeral: string): ExtractedPage {
  const p = scanPage(n, [
    { text: numeral, x: 42, y: 54, size: 11.4 },
    { text: 'Or” morning, as Gregor Samsa was waking up from', x: 43, y: 111, size: 14.3 },
    { text: 'anxious dreams, he discovered that in bed he had been', x: 63, y: 124.5, size: 8.6 },
    ...Array.from({ length: 10 }, (_, i) => ({ text: `${LINE} and`, x: 42, y: 136 + i * 12, size: 9 })),
    { text: 'the last line of this page runs on to the', x: 42, y: 256, size: 9 },
  ]);
  const tall = p.blocks[0].lines[1]; // OCR gives every word of the line the drop cap's height
  tall.b[3] = 133.6;
  for (const w of tall.words) w.b[3] = 133.6;
  return p;
}

const narration = (a: Awaited<ReturnType<typeof analyzeCleaned>>) => a.chapters.flatMap((c) => c.paragraphs.flatMap((p) => p.sentences.map((s) => s.narration)));

describe('page furniture printed inside the page', () => {
  it('removes page numbers and running footers that sit far above the bottom edge', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => bodyPage(i + 1));
    const clean = cleanDocument(pages);
    expect(clean.report.removedPageNumbers).toBe(10);
    expect(clean.report.removedFooters).toEqual(expect.arrayContaining(['FREE EBOOKS AT PLANET EBOOK.COM', 'THE METAMORPHOSIS']));
    const said = narration(await analyzeCleaned(clean, meta(10), { language: 'en', skipFrontMatter: false }));
    expect(said.join(' ')).not.toMatch(/PLANET|METAMORPHOSIS/);
    expect(said.filter((s) => /^\W*\d+\W*$/.test(s))).toEqual([]);
    // the sentence that crosses the page break stays one sentence
    expect(said).toContainEqual(expect.stringMatching(/runs on to the next page where sentence 3 ends\.$/));
  });

  it('removes a page number that OCR misread, where the book prints its page numbers', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => bodyPage(i + 1, { 4: '3B', 7: 'a', 9: 'nm' }[i + 1]));
    const said = narration(await analyzeCleaned(cleanDocument(pages), meta(10), { language: 'en', skipFrontMatter: false }));
    expect(said.filter((s) => s.length <= 4)).toEqual([]);
  });

  it('leaves body text near the bottom of a page that has its page number in the usual margin', () => {
    // Page numbers at the foot (y 610 of 648); the last body line sits just above them.
    const pages = Array.from({ length: 6 }, (_, i) =>
      page(i + 1, [
        ...Array.from({ length: 10 }, (_, k) => ({ text: `${LINE} and more of it`, y: 400 + k * 15 })),
        { text: 'end.', y: 556 },
        { text: String(i + 1), x: 210, y: 610, size: 9 },
      ]),
    );
    const clean = cleanDocument(pages);
    expect(clean.report.removedPageNumbers).toBe(6);
    expect(clean.pages.every((p) => p.lines.some((l) => l.text === 'end.'))).toBe(true);
  });
});

describe('chapter openings of a scanned book', () => {
  it('does not narrate the section number, and keeps the drop-cap line in its sentence', async () => {
    const pages = [chapterPage(1, 'I'), bodyPage(2), bodyPage(3), bodyPage(4), bodyPage(5), chapterPage(6, 'Ul'), bodyPage(7), bodyPage(8), bodyPage(9), bodyPage(10)];
    const toc = [
      { level: 1, title: 'I', page: 1 },
      { level: 1, title: 'II', page: 6 },
    ];
    const a = await analyzeCleaned(cleanDocument(pages), meta(10, toc), { language: 'en', skipFrontMatter: false });
    expect(a.chapters.map((c) => c.title)).toEqual(['I', 'II']);
    for (const c of a.chapters) {
      const first = c.paragraphs[0];
      expect(first.kind).toBe('body');
      expect(first.sentences[0].narration).toMatch(/^Or" morning, as Gregor Samsa was waking up from anxious dreams/);
      expect(first.pageStart).toBe(c.pageStart);
    }
    expect(narration(a).filter((s) => /^(I|Ul)\.?$/.test(s))).toEqual([]);
  });
});

describe('isSectionNumber', () => {
  it.each(['I', 'II.', 'XIV', 'xii', 'Ul', 'Il', 'Ill', '12', '§ 3', '- 4 -', '[7]', '১২'])('"%s" is a section number', (t) => {
    expect(isSectionNumber(t)).toBe(true);
  });
  it.each(['I think', 'MILD', 'DID', 'mix', 'CIVIL', 'CD', '1984', 'U', 'A', 'Chapter 3', 'One'])('"%s" is not', (t) => {
    expect(isSectionNumber(t)).toBe(false);
  });
});

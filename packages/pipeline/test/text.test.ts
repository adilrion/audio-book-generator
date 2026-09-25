import { describe, expect, it } from 'vitest';
import {
  analyzeCleaned,
  buildParagraphs,
  buildVocabulary,
  cleanDocument,
  dehyphenate,
  headerKey,
  looksBroken,
  normalizeNarration,
  splitSentences,
  paraText,
} from '../src';
import type { ExtractionMeta } from '@app/types';
import { bodyLines, page } from './fixtures';

const LONG = 'This line is long enough to reach the right margin of the page for sure';

function meta(pages: number, toc: ExtractionMeta['toc'] = []): ExtractionMeta {
  return { pdfHash: 'x', extractorVersion: 'v', pageCount: pages, toc, wordCount: 1000, emptyPages: [], ocrPages: [], pagesFile: 'p', pageSizes: [] };
}

describe('hyphenation', () => {
  const vocab = new Set(['revolution', 'self-aware', 'well-known']);
  it('joins words broken across lines', () => {
    expect(dehyphenate('Revolu-', 'tion', vocab)).toBe('Revolution');
    expect(dehyphenate('revolu-', 'tion,', vocab)).toBe('revolution,');
  });
  it('keeps real compound hyphens', () => {
    expect(dehyphenate('self-', 'aware', vocab)).toBe('self-aware');
    expect(dehyphenate('well-', 'known', new Set())).toBe('well-known'); // compound prefix rule
    expect(dehyphenate('anti-', 'American', new Set())).toBe('anti-American');
  });
  it('ignores dashes and non-hyphenated tokens', () => {
    expect(dehyphenate('—', 'next', vocab)).toBeNull();
    expect(dehyphenate('word', 'next', vocab)).toBeNull();
  });
  it('merges in paragraphs and keeps both bounding boxes', () => {
    const p = page(1, bodyLines([`${LONG} Industrial Revolu-`, 'tion changed the world.'], 100, false));
    const { pages } = cleanDocument([p]);
    const { paragraphs, dehyphenated } = buildParagraphs(pages, 11, buildVocabulary(pages));
    expect(dehyphenated).toBe(1);
    const tok = paragraphs[0].tokens.find((t) => t.t === 'Revolution')!;
    expect(tok).toBeDefined();
    expect(tok.parts).toHaveLength(2);
    expect(paraText(paragraphs[0])).toContain('Industrial Revolution changed the world.');
  });
});

describe('header/footer removal', () => {
  it('removes running headers, page numbers and TOC leaders', () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) =>
      page(n, [
        { text: 'THE SAMPLE BOOK', y: 30, size: 8 },
        ...bodyLines([`Body text on page ${n} is here and it is long enough to be body text.`], 200),
        ...(n === 2 ? [{ text: 'Introduction . . . . . . . . 7', y: 300 }] : []),
        { text: String(n), x: 210, y: 620, size: 9 },
      ]),
    );
    const { pages: cleaned, report } = cleanDocument(pages);
    const texts = cleaned.flatMap((p) => p.lines.map((l) => l.text));
    expect(texts.some((t) => t.includes('SAMPLE BOOK'))).toBe(false);
    expect(texts.some((t) => /^\d+$/.test(t))).toBe(false);
    expect(texts.some((t) => t.includes('. . . .'))).toBe(false);
    expect(report.removedPageNumbers).toBe(6);
    expect(report.removedTocLines).toBe(1);
    expect(texts.filter((t) => t.startsWith('Body text'))).toHaveLength(6);
  });
  it('normalizes numbers in header keys', () => {
    expect(headerKey('Chapter 3 — The Mill 47')).toBe(headerKey('Chapter 4 — The Mill 112'));
  });
  it('removes duplicated overprinted lines', () => {
    const p = page(1, [...bodyLines(['Same line text here.'], 100), ...bodyLines(['Same line text here.'], 100)]);
    const { pages, report } = cleanDocument([p]);
    expect(pages[0].lines).toHaveLength(1);
    expect(report.removedDuplicates).toBeGreaterThan(0);
  });
});

describe('sentence segmentation', () => {
  const texts = (t: string) => splitSentences(t).map((s) => t.slice(s.start, s.end));
  it('splits sentences and keeps abbreviations together', () => {
    expect(texts('Mr. Smith went to Washington. He arrived at 5 p.m. on time. Dr. Who? Yes!')).toEqual([
      'Mr. Smith went to Washington.',
      'He arrived at 5 p.m. on time.',
      'Dr. Who?',
      'Yes!',
    ]);
  });
  it('handles initials and e.g.', () => {
    expect(texts('J. R. R. Tolkien wrote books, e.g. The Hobbit. It sold well.')).toHaveLength(2);
  });
  it('splits very long sentences at clause boundaries', () => {
    const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} goes on for a while`).join('; ') + '.';
    const parts = texts(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 330)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long);
  });
  it('drops punctuation-only fragments', () => {
    expect(texts('* * *')).toEqual([]);
  });
});

describe('paragraph segmentation', () => {
  it('splits on indentation and vertical gaps, joins across pages', () => {
    const p1 = page(1, [
      ...bodyLines([LONG, 'and the first paragraph ends here.'], 100),
      ...bodyLines([LONG, 'second paragraph ends here.'], 145),
      ...bodyLines([`${LONG} and the third`, `${LONG} continues onto the`], 220),
    ]);
    const p2 = page(2, [...bodyLines(['next page without a break. Then it ends.'], 60, false)]);
    const { pages } = cleanDocument([p1, p2]);
    const { paragraphs } = buildParagraphs(pages, 11, buildVocabulary(pages));
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[2].pageStart).toBe(1);
    expect(paragraphs[2].pageEnd).toBe(2);
    expect(paraText(paragraphs[2])).toContain('continues onto the next page');
  });
});

describe('chapter detection', () => {
  const book = () => {
    const pages = [];
    let n = 1;
    pages.push(page(n++, [{ text: 'A Test Book', y: 200, size: 22, bold: true }]));
    for (let c = 1; c <= 3; c++) {
      pages.push(page(n++, [{ text: `Chapter ${c}`, y: 100, size: 18, bold: true }, { text: 'A Subtitle Here', y: 130, size: 14 }, ...bodyLines([LONG, 'first page of chapter text.'], 180)]));
      pages.push(page(n++, bodyLines([LONG, 'more chapter text on the next page.'], 60)));
    }
    return pages;
  };

  it('uses textual patterns + heading fonts', async () => {
    const pages = book();
    const a = await analyzeCleaned(cleanDocument(pages), meta(pages.length), { language: 'en', skipFrontMatter: false });
    const titles = a.chapters.map((c) => c.title);
    expect(titles).toEqual(['Opening Pages', 'Chapter 1: A Subtitle Here', 'Chapter 2: A Subtitle Here', 'Chapter 3: A Subtitle Here']);
    expect(a.stats.chapterSource).toBe('pattern');
    // heading narrated with a full stop for falling intonation
    expect(a.chapters[1].paragraphs[0].sentences[0].narration).toBe('Chapter 1.');
  });

  it('prefers the PDF outline when present', async () => {
    const pages = book();
    const toc = [
      { level: 1, title: 'Chapter 1', page: 2 },
      { level: 1, title: 'Chapter 2', page: 4 },
      { level: 1, title: 'Chapter 3', page: 6 },
    ];
    const a = await analyzeCleaned(cleanDocument(pages), meta(pages.length, toc), { language: 'en', skipFrontMatter: true });
    expect(a.stats.chapterSource).toBe('toc');
    expect(a.chapters.map((c) => [c.title, c.pageStart])).toEqual([
      ['Chapter 1', 2],
      ['Chapter 2', 4],
      ['Chapter 3', 6],
    ]);
  });

  it('asks the LLM only when structure is ambiguous', async () => {
    const pages = [1, 2, 3].map((n) => page(n, bodyLines([LONG, `plain text ${n} without headings.`], 100)));
    let asked = 0;
    const fakeLlm = {
      model: 'fake',
      used: false,
      available: async () => true,
      pickChapterHeadings: async () => {
        asked++;
        return null;
      },
      repairSentences: async () => null,
      pronunciations: async () => ({}),
    };
    const a = await analyzeCleaned(cleanDocument(pages), meta(3), { language: 'en', skipFrontMatter: false, llm: fakeLlm as never });
    expect(a.chapters).toHaveLength(1);
    expect(asked).toBe(0); // no heading candidates → nothing to adjudicate
  });

  it('maps every sentence to highlight rectangles on its page', async () => {
    const pages = book();
    const a = await analyzeCleaned(cleanDocument(pages), meta(pages.length), { language: 'en', skipFrontMatter: false });
    for (const c of a.chapters)
      for (const p of c.paragraphs)
        for (const s of p.sentences) {
          expect(s.regions.length).toBeGreaterThan(0);
          for (const r of s.regions) for (const rect of r.rects) expect(rect[2]).toBeGreaterThan(rect[0]);
        }
  });
});

describe('narration normalization', () => {
  it('expands abbreviations without touching display text', () => {
    expect(normalizeNarration('Output grew, e.g. cotton & wool rose 50%.', 'en')).toBe('Output grew, for example, cotton and wool rose 50 percent.');
    expect(normalizeNarration('It ended.12 Then more.', 'en')).toBe('It ended. Then more.');
    expect(normalizeNarration('Pi is 3.14 exactly.', 'en')).toBe('Pi is 3.14 exactly.');
  });
  it('applies the pronunciation lexicon on word boundaries', () => {
    expect(normalizeNarration('Nietzsche wrote.', 'en', { Nietzsche: 'Neecha' })).toBe('Neecha wrote.');
  });
  it('detects broken extraction', () => {
    expect(looksBroken('T h e  I n d u s t r i a l  R e v o l u t i o n')).toBe(true);
    expect(looksBroken('The Industrial Revolution changed the world.')).toBe(false);
  });
});

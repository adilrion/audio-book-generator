import { describe, expect, it } from 'vitest';
import type { ExtractionMeta } from '@app/types';
import { analyzeCleaned, cleanDocument, isChapterMarkerLine, looksBroken, normalizeNarration, romanToInt } from '../src';
import { bodyLines, page } from './fixtures';

// Regressions found on a real 280-page book (Project Gutenberg "Pride and Prejudice" printed with Chrome).
const LONG = 'This line is long enough to reach the right margin of the page for sure';
const meta = (n: number): ExtractionMeta => ({ pdfHash: 'x', extractorVersion: 'v', pageCount: n, toc: [], wordCount: 1000, emptyPages: [], ocrPages: [], pagesFile: 'p', pageSizes: [] });

/** Chapter label typeset like body text: body size, not bold, centered, below an illustration caption. */
function chapterPage(n: number, label: string) {
  return page(n, [
    { text: 'He rode a black horse.', x: 170, y: 82, size: 8.7 },
    { text: label, x: 185, y: 106, size: 8.7 },
    ...bodyLines([LONG, `text of the chapter that starts on page ${n}.`], 125, true, 11).map((l) => ({ ...l, size: 8.7 })),
  ]);
}

describe('chapter markers typeset as body text', () => {
  it('recognizes bare marker lines, including a missing space', () => {
    expect(isChapterMarkerLine('CHAPTER III.')).toBe(true);
    expect(isChapterMarkerLine('CHAPTERXXVII.')).toBe(true);
    expect(isChapterMarkerLine('Part Two')).toBe(true);
    expect(isChapterMarkerLine('Chapter: I., II., III.')).toBe(false); // contents line
    expect(isChapterMarkerLine('Parti.')).toBe(false);
    expect(isChapterMarkerLine('Chapter 3 was the best part of the book')).toBe(false);
  });

  it('splits centered body-size chapter lines out of the previous paragraph and detects every chapter', async () => {
    const pages = [
      page(1, bodyLines([LONG, `${LONG} and the opening text continues without`], 100, true, 11).map((l) => ({ ...l, size: 8.7 }))),
      chapterPage(2, 'CHAPTER I.'),
      page(3, bodyLines([LONG, 'more of chapter one here and it ends.'], 60, true, 11).map((l) => ({ ...l, size: 8.7 }))),
      chapterPage(4, 'CHAPTERII.'),
      chapterPage(5, 'CHAPTER III.'),
    ];
    const a = await analyzeCleaned(cleanDocument(pages), meta(pages.length), { language: 'en', skipFrontMatter: false });
    expect(a.chapters.map((c) => c.title)).toEqual(['Opening Pages', 'CHAPTER I.', 'CHAPTERII.', 'CHAPTER III.']);
    expect(a.chapters[1].paragraphs[0].kind).toBe('heading');
    expect(a.chapters[2].paragraphs[0].sentences[0].narration).toBe('Chapter 2.');
    // the caption above the label stays with the previous chapter, not glued to the label
    expect(a.chapters[1].paragraphs[0].text).toBe('CHAPTER I.');
  });

  it('ignores a contents page that lists bare markers', async () => {
    const toc = page(1, ['Chapter I.', 'Chapter II.', 'Chapter III.', 'Chapter IV.'].map((text, i) => ({ text, x: 180, y: 100 + i * 30, size: 8.7 })));
    const pages = [toc, chapterPage(2, 'CHAPTER I.'), chapterPage(3, 'CHAPTER II.')];
    const a = await analyzeCleaned(cleanDocument(pages), meta(pages.length), { language: 'en', skipFrontMatter: false });
    expect(a.chapters.map((c) => [c.title, c.pageStart])).toEqual([
      ['Opening Pages', 1],
      ['CHAPTER I.', 2],
      ['CHAPTER II.', 3],
    ]);
  });
});

describe('narration of chapter numerals', () => {
  it('reads roman numerals after chapter words as numbers', () => {
    expect(normalizeNarration('CHAPTER XIII.', 'en')).toBe('Chapter 13.');
    expect(normalizeNarration('CHAPTERXXVII.', 'en')).toBe('Chapter 27.');
    expect(normalizeNarration('Part II', 'en')).toBe('Part 2');
    expect(romanToInt('XLIV')).toBe(44);
    expect(romanToInt('hello')).toBeNull();
  });
  it('leaves the pronoun I and ordinary words alone', () => {
    expect(normalizeNarration('For my part I think so.', 'en')).toBe('For my part I think so.');
    expect(normalizeNarration('In act I he left.', 'en')).toBe('In act I he left.');
    expect(normalizeNarration('Partial credit.', 'en')).toBe('Partial credit.');
  });
});

describe('damaged-text detection', () => {
  it('does not flag brackets, hashes or asterisks in normal prose', () => {
    expect(looksBroken('[Copyright 1894 by George Allen.]')).toBe(false);
    expect(looksBroken('Release date: June 1, 1998 [eBook #1342]')).toBe(false);
    expect(looksBroken('*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE *** PREFACE.')).toBe(false);
  });
  it('still flags real extraction damage', () => {
    expect(looksBroken('T h e  I n d u s t r i a l  R e v o l u t i o n')).toBe(true);
    expect(looksBroken('The quick brown fox �� jumps over the lazy dog today')).toBe(true);
    expect(looksBroken('Th\u0001e q\u0002uick b\u0003rown f\u0004ox ju\u0005mps ov\u0006er')).toBe(true);
  });
});

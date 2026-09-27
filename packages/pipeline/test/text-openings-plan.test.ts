import { describe, expect, it } from 'vitest';
import type { Analysis, Chapter } from '@app/types';
import { isBackMatterTitle, planChapters, restoreSectionOpenings, type RawParagraph } from '../src';

// Regressions from a real 280-page book whose chapter initials are images (not in the text layer).
const para = (text: string, kind: 'heading' | 'body' = 'body'): RawParagraph => ({
  kind,
  size: kind === 'heading' ? 14 : 10,
  bold: false,
  pageStart: 1,
  pageEnd: 1,
  lines: [],
  tokens: text.split(' ').map((t) => ({ t, parts: [{ page: 1, b: [0, 0, 1, 1] as [number, number, number, number] }] })),
});
const text = (p: RawParagraph) => p.tokens.map((t) => t.t).join(' ');

/** A "book" whose ordinary sentences teach the vocabulary and word pairs. */
function book(openings: string[]): RawParagraph[] {
  const filler = [
    'Mr. Bennet said it is not all that she wanted, and the ladies of the house were not all there.',
    'When Jane came, the ladies were pleased; it is not all bad. Mr. Bennet was among them, and Mr. Bennet smiled.',
    'Elizabeth passed the evening with Elizabeth’s aunt; Elizabeth’s aunt had opinions. Had Elizabeth’s mother known, it is said the day passed well.',
    'The day passed, it is true, and when Jane left the ladies laughed. Not all were glad when it rained; it is a truth the book repeats.',
  ].map((t) => para(t));
  const out: RawParagraph[] = [...filler];
  openings.forEach((o, i) => out.push(para(`CHAPTER ${i + 1}.`, 'heading'), para(o)));
  return out;
}

describe('section openings with a missing drop-cap letter', () => {
  it('restores the missing initial from the book’s own words and word pairs', () => {
    const paras = book(['OT all that she said was true.', 'HE ladies of the house agreed.', 'HEN Jane came home late.', 'R. BENNET was among the first.', 'AD Elizabeth’s mother known more.', 'LIZABETH’S aunt had opinions.']);
    const n = restoreSectionOpenings(paras);
    const opened = paras.filter((p, i) => i > 0 && paras[i - 1].kind === 'heading').map((p) => text(p).split(' ').slice(0, 2).join(' '));
    expect(opened).toEqual(['Not all', 'The ladies', 'When Jane', 'MR. BENNET', 'Had Elizabeth’s', 'Elizabeth’s aunt']);
    expect(n).toBe(6);
  });

  it('undoes small caps for real words but leaves acronyms and non-openings alone', () => {
    const paras = book(['IT is a truth the book repeats.', 'NATO troops arrived at dawn.']);
    paras.splice(1, 0, para('OT all body text in the middle stays as printed.'));
    restoreSectionOpenings(paras);
    expect(text(paras[paras.length - 3]).startsWith('It is a truth')).toBe(true);
    expect(text(paras[paras.length - 1]).startsWith('NATO troops')).toBe(true);
    expect(text(paras[1]).startsWith('OT all body')).toBe(true); // not after a heading
  });

  it('skips an illustration caption between the heading and the text', () => {
    const paras = book([]);
    paras.push(para('CHAPTER 9.', 'heading'), para('“He rode a black horse.”'), para('HEN Jane came in from the rain and sat down.'));
    restoreSectionOpenings(paras);
    expect(text(paras[paras.length - 1]).startsWith('When Jane')).toBe(true);
  });
});

function analysisOf(titles: string[], lastParas: string[] = ['The end of the story.']): Analysis {
  const chapters: Chapter[] = titles.map((title, index) => ({
    index,
    title,
    pageStart: index + 1,
    pageEnd: index + 1,
    source: 'pattern',
    paragraphs: (index === titles.length - 1 ? lastParas : [`Text of ${title}.`]).map((t, pi) => ({
      id: `c${index}-p${pi}`,
      index: pi,
      kind: 'body',
      text: t,
      pageStart: index + 1,
      pageEnd: index + 1,
      regions: [],
      sentences: [{ id: `c${index}-p${pi}-s0`, index: 0, text: t, narration: t, regions: [] }],
    })),
  }));
  return { version: 'v', language: 'en', title: 'T', chapters, lexicon: {}, warnings: [], stats: {} as Analysis['stats'], cleaning: {} as Analysis['cleaning'] };
}

describe('chapter plan: back matter, review edits, range', () => {
  it('recognizes back-matter titles', () => {
    for (const t of ['Index', 'About the Author', 'Also by Jane Doe', 'Section 3. Information about the Project Gutenberg Literary Archive Foundation', 'THE FULL PROJECT GUTENBERG LICENSE'])
      expect(isBackMatterTitle(t), t).toBe(true);
    for (const t of ['Chapter 12', 'The Index Finger Affair', 'Appendix A', 'Epilogue']) expect(isBackMatterTitle(t), t).toBe(false);
  });

  it('drops trailing back matter and everything after a Gutenberg END marker', () => {
    const a = analysisOf(['Chapter 1', 'Chapter 2', 'Section 1. General Terms of Use and Redistributing Project Gutenberg electronic works'], ['x']);
    a.chapters[1].paragraphs.push({ ...a.chapters[1].paragraphs[0], id: 'c1-p1', text: '*** END OF THE PROJECT GUTENBERG EBOOK X ***' }, { ...a.chapters[1].paragraphs[0], id: 'c1-p2', text: 'Licence text.' });
    const plan = planChapters(a, { skipBackMatter: true });
    expect(plan.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(plan.chapters[1].paragraphs.map((p) => p.text)).toEqual(['Text of Chapter 2.']);
    expect(plan.skipped.map((k) => k.reason)).toEqual(['back-matter']);
    expect(a.chapters[1].paragraphs).toHaveLength(3); // the analysis itself is not mutated
    expect(planChapters(a, { skipBackMatter: false }).chapters).toHaveLength(3);
  });

  it('applies review edits only to the analysis they were made for', () => {
    const a = analysisOf(['Cover', 'Chapter 1', 'Chapter 1 (continued)', 'Index']);
    const edits = {
      analysisKey: 'K1',
      items: [
        { index: 0, exclude: true },
        { index: 1, title: 'The Beginning' },
        { index: 2, mergeWithPrevious: true },
        { index: 3, exclude: false }, // keep the index although it is back matter
      ],
    };
    const plan = planChapters(a, { skipBackMatter: true, chapterEdits: edits }, 'K1');
    expect(plan.chapters.map((c) => [c.index, c.title, c.paragraphs.length])).toEqual([
      [1, 'The Beginning', 2],
      [3, 'Index', 1],
    ]);
    expect(plan.chapters[0].pageEnd).toBe(3);
    // stale edits (analysis changed) are ignored
    expect(planChapters(a, { skipBackMatter: true, chapterEdits: edits }, 'OTHER').chapters.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('applies the 1-based chapter range last', () => {
    const a = analysisOf(['A', 'B', 'C', 'D']);
    expect(planChapters(a, { skipBackMatter: true, chapterRange: { from: 2, to: 3 } }).chapters.map((c) => c.title)).toEqual(['B', 'C']);
  });
});

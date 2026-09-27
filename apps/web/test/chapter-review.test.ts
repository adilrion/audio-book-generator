import { DEFAULT_SETTINGS, type ChapterSummary, type ProjectSettings } from '@app/types';
import { describe, expect, it } from 'vitest';
import { buildChapterEdits, estimateNarrationSec, initialReviewRows } from '@/lib/chapter-review';
import { projectPhase, STATUS_LABELS } from '@/lib/stages';

const chapters: ChapterSummary[] = [
  { index: 0, title: 'Opening Pages', pageStart: 1, pageEnd: 17, matter: 'front', wordCount: 5000 },
  { index: 1, title: 'CHAPTER I.', pageStart: 18, pageEnd: 20, wordCount: 850 },
  { index: 2, title: 'CHAPTER II.', pageStart: 20, pageEnd: 22, wordCount: 900 },
  { index: 3, title: 'Section 1. General Terms of Use and Redistributing Project Gutenberg electronic works', pageStart: 278, pageEnd: 278, matter: 'back', wordCount: 3000 },
];
const settings = (text: Partial<ProjectSettings['text']> = {}): ProjectSettings => ({ ...DEFAULT_SETTINGS, text: { ...DEFAULT_SETTINGS.text, ...text } });

describe('chapter review', () => {
  it('starts with back matter unticked, front matter ticked unless skipped', () => {
    expect(initialReviewRows(chapters, settings()).map((r) => r.include)).toEqual([true, true, true, false]);
    expect(initialReviewRows(chapters, settings({ skipFrontMatter: true })).map((r) => r.include)).toEqual([false, true, true, false]);
    expect(initialReviewRows(chapters, settings({ skipBackMatter: false })).map((r) => r.include)).toEqual([true, true, true, true]);
  });

  it('restores an earlier review of the same analysis only', () => {
    const s = settings({ chapterEdits: { analysisKey: 'A', items: [{ index: 0, exclude: true }, { index: 2, title: 'Two', mergeWithPrevious: true }] } });
    const rows = initialReviewRows(chapters, s, 'A');
    expect(rows.map((r) => [r.include, r.title, r.merge])).toEqual([
      [false, 'Opening Pages', false],
      [true, 'CHAPTER I.', false],
      [true, 'Two', true],
      [false, chapters[3].title, false],
    ]);
    expect(initialReviewRows(chapters, s, 'B')[0].include).toBe(true);
  });

  it('sends an explicit keep/leave-out for every chapter plus only real changes', () => {
    const rows = initialReviewRows(chapters, settings());
    rows[0].include = false;
    rows[1].merge = true; // first kept chapter: nothing to merge into → ignored
    rows[2].title = '  Chapter Two ';
    rows[2].merge = true;
    rows[3].include = true; // keep the back matter on purpose
    expect(buildChapterEdits(rows, chapters)).toEqual([
      { index: 0, exclude: true },
      { index: 1, exclude: false },
      { index: 2, exclude: false, title: 'Chapter Two', mergeWithPrevious: true },
      { index: 3, exclude: false },
    ]);
  });

  it('estimates narration from word count and speed', () => {
    expect(Math.round(estimateNarrationSec(1750))).toBe(600);
    expect(Math.round(estimateNarrationSec(1750, 2))).toBe(300);
  });

  it('treats AWAITING_REVIEW as its own phase', () => {
    expect(projectPhase({ status: 'AWAITING_REVIEW', steps: [], snapshot: { status: 'AWAITING_REVIEW', progress: 10, updatedAt: '' } })).toBe('review');
    expect(STATUS_LABELS.AWAITING_REVIEW).toBe('Review chapters');
  });
});

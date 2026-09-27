import type { ChapterEdit, ChapterSummary, ProjectSettings } from '@app/types';

export interface ReviewRow {
  index: number;
  include: boolean;
  title: string;
  merge: boolean;
}

/** Narration pace measured with Kokoro at speed 1.0 on a real novel (≈ 175 words/min). */
export const WORDS_PER_MINUTE = 175;

export function estimateNarrationSec(words: number, speed = 1): number {
  return (words / (WORDS_PER_MINUTE * Math.max(0.5, speed))) * 60;
}

/**
 * Starting state of the review list: an earlier review of the same analysis if there is one;
 * otherwise everything ticked except back matter (and front matter when "Skip front matter" is on).
 */
export function initialReviewRows(chapters: ChapterSummary[], settings: ProjectSettings, analysisKey?: string): ReviewRow[] {
  const prev = settings.text.chapterEdits && settings.text.chapterEdits.analysisKey === analysisKey ? settings.text.chapterEdits.items : undefined;
  const edits = new Map((prev ?? []).map((e) => [e.index, e]));
  return chapters.map((c) => {
    const e = edits.get(c.index);
    const defaultInclude = c.matter === 'back' ? !settings.text.skipBackMatter : c.matter === 'front' ? !settings.text.skipFrontMatter : true;
    return {
      index: c.index,
      include: e?.exclude !== undefined ? !e.exclude : defaultInclude,
      title: e?.title ?? c.title,
      merge: !!e?.mergeWithPrevious,
    };
  });
}

/** One edit per chapter: explicit include/exclude (so kept back matter stays kept), plus changes. */
export function buildChapterEdits(rows: ReviewRow[], chapters: ChapterSummary[]): ChapterEdit[] {
  const original = new Map(chapters.map((c) => [c.index, c.title]));
  let seenKept = false;
  return rows.map((r) => {
    const e: ChapterEdit = { index: r.index, exclude: !r.include };
    const title = r.title.trim();
    if (r.include && title && title !== original.get(r.index)) e.title = title;
    if (r.include && r.merge && seenKept) e.mergeWithPrevious = true;
    if (r.include) seenKept = true;
    return e;
  });
}

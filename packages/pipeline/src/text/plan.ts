import { hashKey } from '@app/shared';
import type { Analysis, Chapter, ChapterEdits, TextSettings } from '@app/types';
import { isBackMatterTitle } from './chapters';

/** Project Gutenberg wraps every book in licence boilerplate between these markers. */
const GUTENBERG_END = /^\*{3}\s*end of (the|this) project gutenberg/i;

/** Fingerprint of a chapter list, as reviewed: same chapters → same signature, whatever produced them. */
export function chaptersSignature(chapters: { index: number; title: string; pageStart: number; pageEnd: number }[]): string {
  return hashKey(chapters.map((c) => [c.index, c.title, c.pageStart, c.pageEnd]));
}

/** Does a saved review belong to this analysis? */
export function reviewApplies(analysis: Analysis, edits: ChapterEdits | undefined, analysisKey?: string): boolean {
  if (!edits) return false;
  if (!analysisKey || edits.analysisKey === analysisKey) return true;
  return !!edits.chaptersSignature && edits.chaptersSignature === chaptersSignature(analysis.chapters);
}

export interface ChapterPlan {
  chapters: Chapter[];
  /** chapter index → why it was left out */
  skipped: { index: number; title: string; reason: 'range' | 'back-matter' | 'excluded' | 'merged' }[];
}

/**
 * What will actually be narrated: the detected chapters after the reviewed edits (rename,
 * exclude, merge), back-matter removal and the chapter range. Pure; never mutates the analysis.
 * Kept chapters keep their original `index` (step keys, cache keys and the UI rely on it).
 */
export function planChapters(analysis: Analysis, text: Pick<TextSettings, 'chapterRange' | 'skipBackMatter' | 'chapterEdits'>, analysisKey?: string): ChapterPlan {
  const skipped: ChapterPlan['skipped'] = [];
  const edits = reviewApplies(analysis, text.chapterEdits, analysisKey) ? text.chapterEdits : undefined;
  const byIndex = new Map((edits?.items ?? []).map((e) => [e.index, e]));
  let chapters: Chapter[] = analysis.chapters.map((c) => ({ ...c, paragraphs: [...c.paragraphs] }));

  if (text.skipBackMatter) {
    // Everything after a Gutenberg END marker is licence text, even inside the last chapter.
    for (let ci = 0; ci < chapters.length; ci++) {
      const pi = chapters[ci].paragraphs.findIndex((p) => GUTENBERG_END.test(p.text.trim()));
      if (pi < 0) continue;
      chapters[ci].paragraphs = chapters[ci].paragraphs.slice(0, pi);
      for (const c of chapters.slice(ci + 1)) skipped.push({ index: c.index, title: c.title, reason: 'back-matter' });
      chapters = chapters.slice(0, ci + 1).filter((c) => c.paragraphs.length > 0);
      break;
    }
    // Trailing back-matter chapters (index, licence, about the author…) unless the review kept them.
    while (chapters.length > 1) {
      const last = chapters[chapters.length - 1];
      if (!isBackMatterTitle(last.title) || byIndex.get(last.index)?.exclude === false) break;
      chapters.pop();
      skipped.push({ index: last.index, title: last.title, reason: 'back-matter' });
    }
  }

  if (edits) {
    const out: Chapter[] = [];
    for (const c of chapters) {
      const e = byIndex.get(c.index);
      if (e?.exclude) {
        skipped.push({ index: c.index, title: c.title, reason: 'excluded' });
        continue;
      }
      const prev = out[out.length - 1];
      if (e?.mergeWithPrevious && prev) {
        prev.paragraphs.push(...c.paragraphs);
        prev.pageEnd = Math.max(prev.pageEnd, c.pageEnd);
        skipped.push({ index: c.index, title: c.title, reason: 'merged' });
        continue;
      }
      out.push({ ...c, title: e?.title?.trim() || c.title });
    }
    chapters = out;
  }

  const r = text.chapterRange;
  if (r) {
    const inRange = (c: Chapter) => c.index + 1 >= r.from && c.index + 1 <= r.to;
    for (const c of chapters) if (!inRange(c)) skipped.push({ index: c.index, title: c.title, reason: 'range' });
    chapters = chapters.filter(inRange);
  }
  return { chapters, skipped };
}

/** The analysis with only the planned chapters — what timeline, subtitles and chapter marks use. */
export function plannedAnalysis(analysis: Analysis, plan: ChapterPlan): Analysis {
  return { ...analysis, chapters: plan.chapters };
}

export type { ChapterEdits };

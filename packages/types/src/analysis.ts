import type { Rect } from './pdf';

/** Screen region of a piece of text on one page: one rect per (partial) line. */
export interface PageRegion {
  page: number;
  rects: Rect[];
  /** characters of the text that fall on this page (used to split timing across pages) */
  chars: number;
}

export interface Sentence {
  /** stable id: c{chapter}-p{paragraph}-s{sentence} */
  id: string;
  /** index within chapter */
  index: number;
  /** Exactly what is printed on the page (after de-hyphenation / whitespace cleanup). */
  text: string;
  /** What the TTS engine speaks. Equals `text` unless normalization/LLM repair changed it. */
  narration: string;
  regions: PageRegion[];
}

export type ParagraphKind = 'heading' | 'body';

export interface Paragraph {
  id: string;
  index: number;
  kind: ParagraphKind;
  text: string;
  pageStart: number;
  pageEnd: number;
  regions: PageRegion[];
  sentences: Sentence[];
}

export type ChapterSource = 'toc' | 'pattern' | 'font' | 'llm' | 'fallback';

export interface Chapter {
  /** 0-based */
  index: number;
  title: string;
  pageStart: number;
  pageEnd: number;
  source: ChapterSource;
  paragraphs: Paragraph[];
}

export interface CleanedLine {
  page: number;
  block: number;
  text: string;
  size: number;
  bold: boolean;
  b: Rect;
  words: { t: string; b: Rect; page: number }[];
}

export interface CleaningReport {
  removedHeaders: string[];
  removedFooters: string[];
  removedPageNumbers: number;
  dehyphenated: number;
  removedDuplicates: number;
  removedTocLines: number;
  bodyFontSize: number;
}

export interface AnalysisStats {
  chapters: number;
  paragraphs: number;
  sentences: number;
  words: number;
  llmUsed: boolean;
  llmRepairs: number;
  chapterSource: ChapterSource;
}

export interface Analysis {
  version: string;
  language: string;
  title: string;
  chapters: Chapter[];
  stats: AnalysisStats;
  cleaning: CleaningReport;
  /** word → spoken respelling, applied to narration */
  lexicon: Record<string, string>;
  warnings: string[];
}

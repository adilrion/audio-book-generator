import type { PdfInspection } from './pdf';
import type { ProgressSnapshot, StepRecord, JobStatus } from './status';
import type { ProjectSettings } from './settings';

export interface ProjectSummary {
  id: string;
  name: string;
  fileName: string;
  status: JobStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  pageCount: number;
  wordCount: number;
  durationSec?: number;
}

export interface ProjectDetail extends ProjectSummary {
  settings: ProjectSettings;
  document: PdfInspection & { hash: string; fileName: string };
  snapshot: ProgressSnapshot;
  steps: StepRecord[];
  outputs: OutputFile[];
  chapters: ChapterSummary[];
  /** Analysis the chapter list belongs to (needed to save a chapter review). */
  analysisKey?: string;
}

export interface OutputFile {
  name: string;
  kind: 'video' | 'audio' | 'subtitles' | 'timeline';
  size: number;
  url: string;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  required: boolean;
  message: string;
  fix?: string;
}

export interface HealthReport {
  ok: boolean;
  checks: HealthCheck[];
}

export interface ChapterSummary {
  index: number;
  title: string;
  pageStart: number;
  pageEnd: number;
  durationSec?: number;
  /** Detected as front matter (cover, contents, copyright…) or back matter (licence, index…). */
  matter?: 'front' | 'back';
  /** Start of the chapter's first body paragraph. */
  preview?: string;
  wordCount?: number;
}

/** A sentence whose extraction damage the local AI repaired (GET /projects/:id/repairs). */
export interface TextRepair {
  /** Stable sentence id, e.g. c3-p12-s1 */
  sentenceId: string;
  chapterIndex: number;
  chapterTitle: string;
  page: number;
  /** What the voice would have read. */
  before: string;
  /** What the voice reads instead. */
  after: string;
}

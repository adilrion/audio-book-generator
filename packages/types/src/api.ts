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
  chapters: { index: number; title: string; pageStart: number; pageEnd: number; durationSec?: number }[];
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

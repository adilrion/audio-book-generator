/** Overall project/job status shown to the user. */
export const JOB_STATUSES = [
  'PENDING',
  'EXTRACTING',
  'CLEANING',
  'ANALYZING',
  'GENERATING_AUDIO',
  'PREPARING_VIDEO',
  'RENDERING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Pipeline stages. Each stage owns one or more persisted steps. */
export const STAGES = ['EXTRACT', 'CLEAN', 'ANALYZE', 'TTS', 'AUDIO_MERGE', 'TIMELINE', 'VIDEO', 'MUX'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_STATUS: Record<Stage, JobStatus> = {
  EXTRACT: 'EXTRACTING',
  CLEAN: 'CLEANING',
  ANALYZE: 'ANALYZING',
  TTS: 'GENERATING_AUDIO',
  AUDIO_MERGE: 'GENERATING_AUDIO',
  TIMELINE: 'PREPARING_VIDEO',
  VIDEO: 'RENDERING',
  MUX: 'RENDERING',
};

/** Relative weight of each stage in the overall progress bar. */
export const STAGE_WEIGHTS: Record<Stage, number> = {
  EXTRACT: 4,
  CLEAN: 2,
  ANALYZE: 4,
  TTS: 55,
  AUDIO_MERGE: 3,
  TIMELINE: 2,
  VIDEO: 28,
  MUX: 2,
};

export const STAGE_LABELS: Record<Stage, string> = {
  EXTRACT: 'PDF Analysis',
  CLEAN: 'Text Cleaning',
  ANALYZE: 'Chapter Detection',
  TTS: 'Audio Generation',
  AUDIO_MERGE: 'Audio Mastering',
  TIMELINE: 'Video Preparation',
  VIDEO: 'Rendering',
  MUX: 'Final Export',
};

export type StepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface UserFacingError {
  /** Stable machine code, e.g. TTS_FAILED, PDF_ENCRYPTED. */
  code: string;
  /** Plain-language message for a normal user. */
  message: string;
  /** Optional next action, e.g. "Start Redis with: docker compose up -d redis". */
  hint?: string;
  stepKey?: string;
  chapterIndex?: number;
  retryable: boolean;
}

export interface StepRecord {
  /** e.g. EXTRACT, TTS_CHAPTER_3, VIDEO_CHAPTER_3 */
  key: string;
  stage: Stage;
  status: StepStatus;
  /** 0..100 within this step */
  progress: number;
  /** Result was reused from cache instead of recomputed. */
  cached?: boolean;
  chapterIndex?: number;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: UserFacingError;
}

export interface ProgressSnapshot {
  status: JobStatus;
  /** 0..100 overall */
  progress: number;
  stage?: Stage;
  stepKey?: string;
  message?: string;
  currentChapter?: number;
  totalChapters?: number;
  warnings?: string[];
  error?: UserFacingError;
  updatedAt: string;
}

import { STAGE_LABELS, STAGES, type JobStatus, type ProjectDetail, type Stage, type StepRecord, type UserFacingError } from '@app/types';

export const ACTIVE_STATUSES: JobStatus[] = ['EXTRACTING', 'CLEANING', 'ANALYZING', 'GENERATING_AUDIO', 'PREPARING_VIDEO', 'RENDERING'];
export const TERMINAL_STATUSES: JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export const isActive = (s: JobStatus) => ACTIVE_STATUSES.includes(s);
export const isTerminal = (s: JobStatus) => TERMINAL_STATUSES.includes(s);

export const STATUS_LABELS: Record<JobStatus, string> = {
  PENDING: 'Pending',
  EXTRACTING: 'Reading PDF',
  CLEANING: 'Cleaning text',
  ANALYZING: 'Detecting chapters',
  GENERATING_AUDIO: 'Generating audio',
  PREPARING_VIDEO: 'Preparing video',
  RENDERING: 'Rendering',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Stages that own one step per chapter. */
export const PER_CHAPTER_STAGES: Stage[] = ['TTS', 'VIDEO'];

export type StageState = 'done' | 'running' | 'pending' | 'failed' | 'skipped' | 'partial';

export interface StageRow {
  stage: Stage;
  label: string;
  state: StageState;
  /** 0..100 */
  progress: number;
  steps: StepRecord[];
  /** every finished step was reused from cache */
  cached: boolean;
  cachedCount: number;
  doneCount: number;
  message?: string;
  elapsed?: { from: string; to: string };
  error?: UserFacingError;
}

/** Lifecycle phase of a project as the UI sees it. */
export type Phase = 'idle' | 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';

export function projectPhase(p: Pick<ProjectDetail, 'status' | 'steps' | 'snapshot'>): Phase {
  switch (p.status) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'PENDING':
      // A fresh upload has no snapshot message; POST /process sets "Waiting for the worker…".
      return p.snapshot?.message ? 'queued' : 'idle';
    default:
      return 'active';
  }
}

/**
 * Steps of the latest run. Steps finished by an *earlier* run keep their COMPLETED/FAILED status
 * until the runner reaches them again, and steps outside this run's plan (another chapter range,
 * video steps of an earlier audiobook-and-video run) are never touched again. Every run starts
 * with EXTRACT, so anything finished before the current EXTRACT started is stale:
 * - while running, or after a failed / cancelled run, it is shown as pending (not reached yet);
 * - after a completed run it was not part of the run at all, so it is left out (as are steps
 *   that never finished — a completed run finished every step it planned).
 */
export function currentRunSteps(p: Pick<ProjectDetail, 'status' | 'steps' | 'snapshot'>): StepRecord[] {
  const phase = projectPhase(p);
  if (phase === 'idle' || phase === 'queued') return p.steps;
  const runStart = p.steps.find((s) => s.key === 'EXTRACT')?.startedAt;
  if (!runStart) return p.steps;
  const finished = (s: StepRecord) => s.status === 'COMPLETED' || s.status === 'FAILED' || s.status === 'SKIPPED';
  const stale = (s: StepRecord) => s.key !== 'EXTRACT' && finished(s) && (!s.finishedAt || s.finishedAt < runStart);
  if (phase === 'completed') return p.steps.filter((s) => s.key === 'EXTRACT' || (s.status !== 'FAILED' && finished(s) && !stale(s)));
  return p.steps.map((s) => (stale(s) ? { ...s, status: 'PENDING', progress: 0, cached: false, error: undefined, message: undefined } : s));
}

const earliest = (xs: (string | undefined)[]) => xs.filter(Boolean).sort()[0];
const latest = (xs: (string | undefined)[]) => xs.filter(Boolean).sort().at(-1);

/**
 * Group persisted steps into the eight user-facing stages. TTS/VIDEO aggregate their
 * TTS_CHAPTER_n / VIDEO_CHAPTER_n steps.
 */
export function deriveStages(p: Pick<ProjectDetail, 'status' | 'steps' | 'snapshot' | 'settings'>): StageRow[] {
  const phase = projectPhase(p);
  const audioOnly = p.settings.outputMode === 'audiobook_only';
  const running = phase === 'active' ? p.snapshot?.stage : undefined;
  const all = currentRunSteps(p);

  return STAGES.map((stage): StageRow => {
    const steps = all.filter((s) => s.stage === stage).sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0));
    const done = steps.filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED');
    const cachedCount = steps.filter((s) => s.status === 'COMPLETED' && s.cached).length;
    const failed = steps.find((s) => s.status === 'FAILED');
    const anyRunning = steps.some((s) => s.status === 'RUNNING');
    const progress = steps.length
      ? steps.reduce((n, s) => n + (s.status === 'COMPLETED' || s.status === 'SKIPPED' ? 100 : Math.max(0, Math.min(100, s.progress ?? 0))), 0) / steps.length
      : 0;

    let state: StageState;
    if (failed) state = 'failed';
    else if (steps.length && done.length === steps.length) state = steps.every((s) => s.status === 'SKIPPED') ? 'skipped' : 'done';
    else if (phase === 'active' && (anyRunning || running === stage)) state = 'running';
    else if (!steps.length && audioOnly && (stage === 'VIDEO' || stage === 'MUX')) state = 'skipped';
    else if (!steps.length && phase === 'completed') state = 'done'; // steps were cleared by "Clean project cache"
    else if (done.length > 0) state = 'partial';
    else state = 'pending';

    const current = steps.find((s) => s.status === 'RUNNING') ?? failed;
    const last = [...done].sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '')).at(-1);
    const from = earliest(steps.map((s) => s.startedAt));
    const to = state === 'done' ? latest(steps.map((s) => s.finishedAt)) : undefined;

    let message: string | undefined;
    if (state === 'skipped' && !steps.length) message = 'Not needed for audiobook-only output';
    else if (PER_CHAPTER_STAGES.includes(stage) && steps.length > 1 && state !== 'done') message = `${done.length} of ${steps.length} chapters`;
    else message = (current ?? last)?.message;

    return {
      stage,
      label: STAGE_LABELS[stage],
      state,
      progress: state === 'done' || state === 'skipped' ? 100 : Math.round(progress),
      steps,
      cached: done.length > 0 && cachedCount === done.length && state === 'done',
      cachedCount,
      doneCount: done.length,
      message,
      elapsed: from && to ? { from, to } : undefined,
      error: failed?.error,
    };
  });
}

/** The error to show for a failed project (snapshot error, else the failed step's). */
export function projectError(p: Pick<ProjectDetail, 'status' | 'steps' | 'snapshot'>): UserFacingError | undefined {
  if (p.status !== 'FAILED') return undefined;
  return p.snapshot?.error ?? currentRunSteps(p).find((s) => s.status === 'FAILED')?.error;
}

/** "Retry Chapter 7", "Retry Final Export", or plain "Retry". chapterIndex is 0-based. */
export function retryLabel(err: UserFacingError | undefined, steps: StepRecord[] = []): string {
  if (!err) return 'Retry';
  // Crash / reboot mid-run (worker recoverInterrupted): the hint tells the user to "Click Resume".
  if (err.code === 'INTERRUPTED') return 'Resume';
  if (err.chapterIndex !== undefined && err.chapterIndex !== null) return `Retry Chapter ${err.chapterIndex + 1}`;
  const m = err.stepKey?.match(/^(TTS|VIDEO)_CHAPTER_(\d+)$/);
  if (m) return `Retry Chapter ${m[2]}`;
  const step = err.stepKey ? steps.find((s) => s.key === err.stepKey) : undefined;
  const stage = step?.stage ?? (STAGES as readonly string[]).find((s) => s === err.stepKey);
  return stage ? `Retry ${STAGE_LABELS[stage as Stage]}` : 'Retry';
}

/** Human label for a single step, e.g. TTS_CHAPTER_3 → "Chapter 3". */
export function stepLabel(step: StepRecord, chapterTitles?: Map<number, string>): string {
  if (step.chapterIndex !== undefined) {
    const title = chapterTitles?.get(step.chapterIndex);
    return title ? `${step.chapterIndex + 1}. ${title}` : `Chapter ${step.chapterIndex + 1}`;
  }
  return STAGE_LABELS[step.stage] ?? step.key;
}

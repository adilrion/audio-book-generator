'use client';

import type { ProjectDetail, StepRecord } from '@app/types';
import { Ban, ChevronRight, CircleCheck, CircleMinus, CircleX, Circle, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatElapsed } from '@/lib/format';
import { currentRunSteps, deriveStages, PER_CHAPTER_STAGES, projectPhase, type StageRow, type StageState, stepLabel } from '@/lib/stages';
import { cn } from '@/lib/utils';

function StateIcon({ state, className }: { state: StageState | StepRecord['status']; className?: string }) {
  const c = cn('size-[18px] shrink-0', className);
  switch (state) {
    case 'done':
    case 'COMPLETED':
      return <CircleCheck className={cn(c, 'text-success')} aria-label="Done" />;
    case 'running':
    case 'RUNNING':
      return <LoaderCircle className={cn(c, 'animate-spin text-info')} aria-label="In progress" />;
    case 'failed':
    case 'FAILED':
      return <CircleX className={cn(c, 'text-destructive')} aria-label="Failed" />;
    case 'skipped':
    case 'SKIPPED':
      return <CircleMinus className={cn(c, 'text-muted-foreground/70')} aria-label="Skipped" />;
    case 'partial':
      return <Circle className={cn(c, 'text-info/70')} strokeDasharray="4 3" aria-label="Partly done" />;
    default:
      return <Circle className={cn(c, 'text-muted-foreground/40')} aria-label="Waiting" />;
  }
}

function ChapterSteps({ steps, titles }: { steps: StepRecord[]; titles: Map<number, string> }) {
  return (
    <ul className="grid gap-1.5 py-1 pl-7 text-xs">
      {steps.map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-2">
          <StateIcon state={s.status} className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{stepLabel(s, titles)}</span>
          {s.status === 'RUNNING' && <span className="text-muted-foreground tabular">{s.progress}%</span>}
          {s.status === 'COMPLETED' && s.cached && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              cached
            </Badge>
          )}
          {s.message && s.status !== 'FAILED' && <span className="hidden truncate text-muted-foreground sm:inline">{s.message}</span>}
          {s.status === 'FAILED' && <span className="truncate text-destructive">{s.error?.message ?? 'Failed'}</span>}
          {s.status === 'COMPLETED' && <span className="shrink-0 text-muted-foreground/70 tabular">{formatElapsed(s.startedAt, s.finishedAt)}</span>}
        </li>
      ))}
    </ul>
  );
}

function StageRowView({ row, chapterLine, titles }: { row: StageRow; chapterLine?: string; titles: Map<number, string> }) {
  const expandable = PER_CHAPTER_STAGES.includes(row.stage) && row.steps.length > 0;
  const [open, setOpen] = useState(false);
  const elapsed = row.elapsed ? formatElapsed(row.elapsed.from, row.elapsed.to) : undefined;
  const cachedTag = row.cached ? '(cached)' : row.cachedCount > 0 && row.state !== 'pending' ? `(${row.cachedCount} of ${row.steps.length} cached)` : undefined;

  return (
    <li className={cn('grid gap-1 px-4 py-2.5 sm:px-5', row.state === 'running' && 'bg-info/[0.05]', row.state === 'failed' && 'bg-destructive/[0.05]')}>
      <div className="flex min-w-0 items-center gap-3">
        <StateIcon state={row.state} />
        <button
          type="button"
          className={cn('flex min-w-0 items-center gap-1 text-left text-sm font-medium', !expandable && 'pointer-events-none')}
          onClick={() => expandable && setOpen((o) => !o)}
          aria-expanded={expandable ? open : undefined}
          tabIndex={expandable ? 0 : -1}
        >
          <span className={cn('truncate', row.state === 'pending' && 'text-muted-foreground', row.state === 'skipped' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>
            {row.label}
          </span>
          {expandable && <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />}
        </button>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {row.state === 'running' || row.state === 'partial' ? (
            <div className="flex items-center gap-2">
              <Progress value={row.progress} className="h-2 w-24 sm:w-40" indicatorClassName={row.state === 'running' ? 'bg-info' : 'bg-info/50'} />
              <span className="w-9 text-right text-xs text-muted-foreground tabular">{row.progress}%</span>
            </div>
          ) : null}
          {cachedTag && <span className="hidden text-xs text-muted-foreground sm:inline">{cachedTag}</span>}
          {elapsed && row.state === 'done' && <span className="hidden text-xs text-muted-foreground/70 tabular sm:inline">{elapsed}</span>}
        </div>
      </div>
      {(row.message || chapterLine || row.error) && (
        <p className={cn('truncate pl-[30px] text-xs', row.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          {row.state === 'failed' ? (row.error?.message ?? row.message) : [chapterLine, row.message].filter(Boolean).join(' · ')}
          {cachedTag && <span className="sm:hidden"> {cachedTag}</span>}
        </p>
      )}
      {expandable && open && <ChapterSteps steps={row.steps} titles={titles} />}
    </li>
  );
}

/** Live per-stage progress, as in the spec: ✓ / spinner / ○ / ✗ rows with the running stage's bar. */
export function ProcessingPanel({ project }: { project: ProjectDetail }) {
  const rows = useMemo(() => deriveStages(project), [project]);
  const titles = useMemo(() => new Map(project.chapters.map((c) => [c.index, c.title])), [project.chapters]);
  const phase = projectPhase(project);
  const snap = project.snapshot;
  const progress = Math.round(phase === 'completed' ? 100 : (project.progress ?? snap?.progress ?? 0));
  const chapterLine =
    phase === 'active' && snap?.currentChapter && snap?.totalChapters && (snap.stage === 'TTS' || snap.stage === 'VIDEO') ? `Chapter ${snap.currentChapter} of ${snap.totalChapters}` : undefined;
  const warnings = snap?.warnings?.filter(Boolean) ?? [];
  const runSteps = currentRunSteps(project);
  const cachedSteps = runSteps.filter((s) => s.status === 'COMPLETED' && s.cached).length;

  const heading =
    phase === 'completed'
      ? 'Finished'
      : phase === 'failed'
        ? 'Stopped with an error'
        : phase === 'cancelled'
          ? 'Cancelled'
          : phase === 'queued'
            ? 'Queued'
            : phase === 'idle'
              ? 'Not started yet'
              : 'Processing';

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 px-4 sm:px-5">
        <div className="flex items-end justify-between gap-4">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-sm font-medium">
              {heading}
              {phase === 'active' || phase === 'queued' ? (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  “{project.document.fileName}”
                </span>
              ) : null}
            </p>
            <p className="truncate text-xs text-muted-foreground" aria-live="polite">
              {phase === 'idle'
                ? 'Review the settings below, then press Start.'
                : phase === 'queued'
                  ? (snap?.message ?? 'Waiting for the worker…')
                  : phase === 'active'
                    ? [chapterLine, snap?.message].filter(Boolean).join(' — ') || 'Working…'
                    : phase === 'completed'
                      ? cachedSteps
                        ? `${cachedSteps} step${cachedSteps === 1 ? '' : 's'} reused from cache.`
                        : 'All stages complete.'
                      : phase === 'cancelled'
                        ? 'Finished steps are kept — Resume continues where it stopped.'
                        : 'Finished steps are kept — retrying continues from the failed step.'}
            </p>
          </div>
          <span className="text-2xl font-semibold tracking-tight tabular">{progress}%</span>
        </div>
        <Progress
          value={progress}
          className="h-2.5"
          indicatorClassName={cn(phase === 'completed' && 'bg-success', phase === 'failed' && 'bg-destructive', phase === 'cancelled' && 'bg-muted-foreground/50', phase === 'active' && 'bg-info')}
        />
      </div>

      <ul className="divide-y border-y">
        {rows.map((row) => (
          <StageRowView key={row.stage} row={row} titles={titles} chapterLine={row.state === 'running' && snap?.stage === row.stage ? chapterLine : undefined} />
        ))}
      </ul>

      {phase === 'cancelled' && (
        <div className="px-4 sm:px-5">
          <Alert>
            <Ban aria-hidden />
            <AlertTitle>Processing was cancelled</AlertTitle>
            <AlertDescription>Completed chapters and stages are cached. Resume to continue without redoing them.</AlertDescription>
          </Alert>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="px-4 sm:px-5">
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>{warnings.length === 1 ? 'Warning' : `${warnings.length} warnings`}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
}

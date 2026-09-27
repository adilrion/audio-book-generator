'use client';

import type { ProjectDetail, StepRecord } from '@app/types';
import { Ban, Check, ChevronRight, CircleCheck, CircleMinus, CircleX, Circle, LoaderCircle, Minus, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AudioBars } from '@/components/audio-bars';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatElapsed } from '@/lib/format';
import { currentRunSteps, deriveStages, PER_CHAPTER_STAGES, projectPhase, type StageRow, type StageState, stepLabel } from '@/lib/stages';
import { cn } from '@/lib/utils';

function StepIcon({ state, className }: { state: StepRecord['status']; className?: string }) {
  const c = cn('size-3.5 shrink-0', className);
  switch (state) {
    case 'COMPLETED':
      return <CircleCheck className={cn(c, 'text-success')} aria-label="Done" />;
    case 'RUNNING':
      return <LoaderCircle className={cn(c, 'animate-spin text-info')} aria-label="In progress" />;
    case 'FAILED':
      return <CircleX className={cn(c, 'text-destructive')} aria-label="Failed" />;
    case 'SKIPPED':
      return <CircleMinus className={cn(c, 'text-muted-foreground/70')} aria-label="Skipped" />;
    default:
      return <Circle className={cn(c, 'text-muted-foreground/40')} aria-label="Waiting" />;
  }
}

/** The node on the pipeline's rail. */
function StageNode({ state }: { state: StageState }) {
  const base = 'relative z-10 grid size-6 shrink-0 place-items-center rounded-full';
  switch (state) {
    case 'done':
      return (
        <span className={cn(base, 'bg-success text-success-foreground')} aria-label="Done">
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
      );
    case 'running':
      return (
        <span className={cn(base, 'bg-info/15 text-info ring-2 ring-info')} aria-label="In progress">
          <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.5} aria-hidden />
        </span>
      );
    case 'failed':
      return (
        <span className={cn(base, 'bg-destructive text-white')} aria-label="Failed">
          <X className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
      );
    case 'skipped':
      return (
        <span className={cn(base, 'bg-muted text-muted-foreground')} aria-label="Skipped">
          <Minus className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
      );
    case 'partial':
      return (
        <span className={cn(base, 'border-2 border-dashed border-info/60 bg-card')} aria-label="Partly done">
          <span className="size-1.5 rounded-full bg-info/70" />
        </span>
      );
    default:
      return <span className={cn(base, 'border-2 bg-card')} aria-label="Waiting" />;
  }
}

function ChapterSteps({ steps, titles }: { steps: StepRecord[]; titles: Map<number, string> }) {
  return (
    <ul className="mt-1 grid max-h-72 gap-1.5 overflow-y-auto rounded-lg bg-muted/50 p-2.5 text-xs scrollbar-thin">
      {steps.map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-2">
          <StepIcon state={s.status} />
          <span className="min-w-0 flex-1 truncate">{stepLabel(s, titles)}</span>
          {s.status === 'RUNNING' && <span className="text-muted-foreground tabular">{s.progress}%</span>}
          {s.status === 'COMPLETED' && s.cached && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              cached
            </Badge>
          )}
          {s.message && s.status !== 'FAILED' && <span className="hidden truncate text-muted-foreground sm:inline">{s.message}</span>}
          {s.status === 'FAILED' && <span className="truncate text-destructive">{s.error?.message ?? 'Failed'}</span>}
          {s.status === 'COMPLETED' && <span className="shrink-0 text-muted-foreground tabular">{formatElapsed(s.startedAt, s.finishedAt)}</span>}
        </li>
      ))}
    </ul>
  );
}

function StageRowView({ row, chapterLine, titles, last }: { row: StageRow; chapterLine?: string; titles: Map<number, string>; last: boolean }) {
  const expandable = PER_CHAPTER_STAGES.includes(row.stage) && row.steps.length > 0;
  const [open, setOpen] = useState(false);
  const elapsed = row.elapsed ? formatElapsed(row.elapsed.from, row.elapsed.to) : undefined;
  const cachedTag = row.cached ? 'cached' : row.cachedCount > 0 && row.state !== 'pending' ? `${row.cachedCount} of ${row.steps.length} cached` : undefined;
  const detail = row.state === 'failed' ? (row.error?.message ?? row.message) : [chapterLine, row.message].filter(Boolean).join(' · ');

  return (
    <li className="relative flex gap-3.5">
      {!last && <span className={cn('absolute top-7 bottom-0 left-[11px] w-0.5 rounded-full', row.state === 'done' || row.state === 'skipped' ? 'bg-success/35' : 'bg-border')} aria-hidden />}
      <StageNode state={row.state} />
      <div className={cn('grid min-w-0 flex-1 gap-1', last ? 'pb-1' : 'pb-5')}>
        <div className="flex min-h-6 min-w-0 items-center gap-3">
          <button
            type="button"
            className={cn('flex min-w-0 items-center gap-1 rounded text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', !expandable && 'pointer-events-none')}
            onClick={() => expandable && setOpen((o) => !o)}
            aria-expanded={expandable ? open : undefined}
            tabIndex={expandable ? 0 : -1}
          >
            <span className={cn('truncate', row.state === 'pending' && 'text-muted-foreground', row.state === 'skipped' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>
              {row.label}
            </span>
            {expandable && <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {cachedTag && (
              <Badge variant="muted" className="hidden px-1.5 py-0 text-[10px] sm:inline-flex">
                {cachedTag}
              </Badge>
            )}
            {row.state === 'running' || row.state === 'partial' ? <span className="tabular">{row.progress}%</span> : null}
            {elapsed && row.state === 'done' && <span className="tabular">{elapsed}</span>}
          </div>
        </div>
        {(row.state === 'running' || row.state === 'partial') && (
          <Progress value={row.progress} live={row.state === 'running'} className="h-1.5" indicatorClassName={row.state === 'running' ? 'bg-info' : 'bg-info/50'} />
        )}
        {detail && <p className={cn('truncate text-xs', row.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{detail}</p>}
        {expandable && open && <ChapterSteps steps={row.steps} titles={titles} />}
      </div>
    </li>
  );
}

/** Live per-stage progress: the overall bar, then every stage on a rail with the running one expanded. */
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

  const paused = phase === 'active' && !!snap?.power?.paused;
  const heading = paused
    ? 'Paused'
    : phase === 'completed'
      ? 'Finished'
      : phase === 'failed'
        ? 'Stopped with an error'
        : phase === 'cancelled'
          ? 'Cancelled'
          : phase === 'review'
            ? 'Waiting for your chapter review'
            : phase === 'queued'
              ? 'Queued'
              : phase === 'idle'
                ? 'Not started yet'
                : 'Processing';

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <div className="flex items-end justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <p className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              {phase === 'active' && <AudioBars paused={paused} className="h-3 text-info" />}
              {heading}
            </p>
            <p className="line-clamp-2 text-sm text-muted-foreground" aria-live="polite">
              {phase === 'idle'
                ? 'Review the settings, then press Start.'
                : phase === 'queued'
                  ? (snap?.message ?? 'Waiting for the worker…')
                  : phase === 'active'
                    ? [chapterLine, snap?.message].filter(Boolean).join(' — ') || 'Working…'
                    : phase === 'completed'
                      ? cachedSteps
                        ? `${cachedSteps} step${cachedSteps === 1 ? '' : 's'} reused from cache.`
                        : 'All stages complete.'
                      : phase === 'review'
                        ? 'The PDF is analysed. Check the chapter list, then start narration.'
                        : phase === 'cancelled'
                          ? 'Finished steps are kept — Resume continues where it stopped.'
                          : 'Finished steps are kept — retrying continues from the failed step.'}
            </p>
          </div>
          <span className="text-4xl leading-none font-semibold tracking-tight tabular">
            {progress}
            <span className="text-lg font-medium text-muted-foreground">%</span>
          </span>
        </div>
        <Progress
          value={progress}
          live={phase === 'active' && !paused}
          className="h-2.5"
          indicatorClassName={cn(
            phase === 'completed' && 'bg-success',
            phase === 'failed' && 'bg-destructive',
            phase === 'cancelled' && 'bg-muted-foreground/50',
            phase === 'review' && 'bg-warning',
            phase === 'active' && 'bg-info',
          )}
        />
      </div>

      <ol className="grid" aria-label="Stages">
        {rows.map((row, i) => (
          <StageRowView
            key={row.stage}
            row={row}
            titles={titles}
            last={i === rows.length - 1}
            chapterLine={row.state === 'running' && snap?.stage === row.stage ? chapterLine : undefined}
          />
        ))}
      </ol>

      {phase === 'cancelled' && (
        <Alert>
          <Ban aria-hidden />
          <AlertTitle>Processing was cancelled</AlertTitle>
          <AlertDescription>Completed chapters and stages are cached. Resume to continue without redoing them.</AlertDescription>
        </Alert>
      )}

      {warnings.length > 0 && (
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
      )}
    </div>
  );
}

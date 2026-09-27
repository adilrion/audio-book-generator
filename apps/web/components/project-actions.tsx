'use client';

import type { ProjectDetail } from '@app/types';
import { CircleX, Download, Ellipsis, Eraser, ListChecks, LoaderCircle, Play, RotateCcw, SlidersHorizontal, Square, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { ApiErrorAlert, ErrorHint } from '@/components/api-error-alert';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { type ApiError, api, apiUrl, toApiError } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { type Phase, projectError, projectPhase, retryLabel } from '@/lib/stages';
import { cn } from '@/lib/utils';

type Action = 'start' | 'retry' | 'restart' | 'cancel' | 'clean' | 'delete';
type DialogKind = 'restart' | 'clean' | 'delete';

export interface ProjectCommands {
  busy: Action | null;
  error?: ApiError;
  dialog: DialogKind | null;
  openDialog: (d: DialogKind | null) => void;
  run: (action: Action, fn: () => Promise<unknown>, after?: (r: unknown) => void) => Promise<void>;
}

/** Shared state for the project's actions, so the header and the failure alert never both run one. */
export function useProjectCommands(onChanged: () => void): ProjectCommands {
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<ApiError>();
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  const run = useCallback(
    async (action: Action, fn: () => Promise<unknown>, after?: (r: unknown) => void) => {
      setBusy(action);
      setError(undefined);
      try {
        const r = await fn();
        setDialog(null);
        after?.(r);
        if (action !== 'delete') onChanged(); // a deleted project has nothing left to re-fetch
      } catch (e) {
        setError(toApiError(e));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );
  const openDialog = useCallback((d: DialogKind | null) => {
    setDialog(d);
    setError(undefined);
  }, []);

  return { busy, error, dialog, openDialog, run };
}

function RetryButton({ project, cmds, className }: { project: ProjectDetail; cmds: ProjectCommands; className?: string }) {
  const err = projectError(project);
  return (
    <Button onClick={() => void cmds.run('retry', () => api.retry(project.id))} disabled={!!cmds.busy} variant={err?.retryable === false ? 'outline' : 'default'} className={className}>
      {cmds.busy === 'retry' ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />} {retryLabel(err, project.steps)}
    </Button>
  );
}

/** The failed run's error, what to do about it and a retry that continues from the failed step. */
export function FailureAlert({ project, cmds, onReviewSettings }: { project: ProjectDetail; cmds: ProjectCommands; onReviewSettings: () => void }) {
  const err = projectError(project);
  if (projectPhase(project) !== 'failed' || !err) return null;
  return (
    <Alert variant="destructive">
      <CircleX aria-hidden />
      <AlertTitle>{err.message}</AlertTitle>
      <AlertDescription>
        <ErrorHint hint={err.hint} />
        {err.retryable === false && <p>Retrying with the same settings will not fix this — change the settings (or the PDF) first.</p>}
        <div className="mt-2 flex flex-wrap gap-2 text-foreground">
          {err.retryable === false && (
            <Button onClick={onReviewSettings}>
              <SlidersHorizontal aria-hidden /> Review settings
            </Button>
          )}
          <RetryButton project={project} cmds={cmds} />
        </div>
      </AlertDescription>
    </Alert>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  busy,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  error?: ApiError;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2 leading-relaxed">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {children}
        {error && <ApiErrorAlert error={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" aria-hidden />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectActionsProps {
  project: ProjectDetail;
  cmds: ProjectCommands;
  /** Informational result, e.g. "Freed 120 MB". */
  onNotice: (message: string) => void;
  /** Open the chapter review (pending review, or editing the chapters of a finished run). */
  onReviewChapters: () => void;
  className?: string;
}

/**
 * The project's primary action for its phase (Start / Cancel / Retry / Resume / Download) plus a
 * menu with Restart, Clean cache and Delete — with confirmations for the destructive ones.
 */
export function ProjectActions({ project, cmds, onNotice, onReviewChapters, className }: ProjectActionsProps) {
  const router = useRouter();
  const phase: Phase = projectPhase(project);
  const [deleteOutputs, setDeleteOutputs] = useState(false);
  const deleteId = useId();
  const running = phase === 'active' || phase === 'queued';
  const { busy, error, dialog, openDialog, run } = cmds;

  const hasOutputs = project.outputs.some((o) => o.kind === 'video' || o.kind === 'audio');
  const main = project.outputs.find((o) => o.name === 'audiobook.mp4') ?? project.outputs.find((o) => o.name === 'audiobook.m4a');
  const canEditChapters = !!project.analysisKey && (phase === 'completed' || phase === 'failed' || phase === 'cancelled');

  let primary: ReactNode = null;
  if (phase === 'idle')
    primary = (
      <Button variant="brand" onClick={() => void run('start', () => api.process(project.id))} disabled={!!busy}>
        {busy === 'start' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play className="fill-current" aria-hidden />} Start processing
      </Button>
    );
  else if (phase === 'review')
    primary = (
      <Button variant="brand" onClick={onReviewChapters}>
        <ListChecks aria-hidden /> Review chapters
      </Button>
    );
  else if (phase === 'cancelled')
    primary = (
      <Button onClick={() => void run('start', () => api.process(project.id))} disabled={!!busy}>
        {busy === 'start' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play className="fill-current" aria-hidden />} Resume
      </Button>
    );
  // With a known error the failure alert below carries the retry, next to the explanation.
  else if (phase === 'failed' && !projectError(project)) primary = <RetryButton project={project} cmds={cmds} />;
  else if (running)
    primary = (
      <Button variant="outline" onClick={() => void run('cancel', () => api.cancel(project.id))} disabled={!!busy}>
        {busy === 'cancel' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Square className="size-3.5 fill-current" aria-hidden />} Cancel
      </Button>
    );
  else if (phase === 'completed' && main)
    primary = (
      <Button asChild variant="brand">
        <a href={apiUrl(main.url)} download={main.name}>
          <Download aria-hidden /> Download {main.name.endsWith('.mp4') ? 'video' : 'audiobook'}
        </a>
      </Button>
    );

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {primary}
      {/* modal={false}: a dialog opened from a menu item must not fight the menu over focus */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions" title="More actions">
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {running && <DropdownMenuLabel className="font-normal">Available once processing stops</DropdownMenuLabel>}
          {canEditChapters && (
            <DropdownMenuItem onSelect={onReviewChapters}>
              <ListChecks aria-hidden /> Review chapters
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => openDialog('restart')} disabled={running || phase === 'idle' || !!busy}>
            <RotateCcw aria-hidden /> Restart from scratch…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog('clean')} disabled={running || !!busy}>
            <Eraser aria-hidden /> Clean project cache…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => openDialog('delete')} disabled={running || !!busy}>
            <Trash2 aria-hidden /> Delete project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={dialog === 'restart'}
        onOpenChange={(o) => openDialog(o ? 'restart' : null)}
        title="Restart from scratch?"
        description={
          <>
            <p>Every stage is redone and caches are ignored — PDF analysis, all narration and the video. This can take a long time for a full book.</p>
            <p>To apply changed settings, use “Save &amp; re-run” instead — it only recomputes what changed.</p>
          </>
        }
        confirmLabel="Restart everything"
        busy={busy === 'restart'}
        error={dialog === 'restart' ? error : undefined}
        onConfirm={() => void run('restart', () => api.restart(project.id))}
      />

      <ConfirmDialog
        open={dialog === 'clean'}
        onOpenChange={(o) => openDialog(o ? 'clean' : null)}
        title="Clean project cache?"
        description={
          <>
            <p>Removes intermediate files (extracted text, chapter audio, video segments, page previews) to free disk space.</p>
            <p className="font-medium text-foreground">Your final outputs (MP4, M4A, SRT) are never deleted.</p>
            <p>A later re-run will need to regenerate the cached stages.</p>
          </>
        }
        confirmLabel="Clean cache"
        busy={busy === 'clean'}
        error={dialog === 'clean' ? error : undefined}
        onConfirm={() =>
          void run(
            'clean',
            () => api.cleanCache(project.id),
            (r) => onNotice(`Cache cleaned — freed ${formatBytes((r as { freedBytes: number }).freedBytes)}.`),
          )
        }
      />

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => {
          openDialog(o ? 'delete' : null);
          setDeleteOutputs(false);
        }}
        title={`Delete “${project.name}”?`}
        description={
          <p>
            The project and its cache are removed.{' '}
            {hasOutputs ? 'Final outputs are kept in storage/output unless you choose to delete them too.' : 'The uploaded PDF is removed if no other project uses it.'}
          </p>
        }
        confirmLabel={deleteOutputs ? 'Delete project and outputs' : 'Delete project'}
        destructive
        busy={busy === 'delete'}
        error={dialog === 'delete' ? error : undefined}
        onConfirm={() =>
          void run(
            'delete',
            () => api.deleteProject(project.id, deleteOutputs),
            () => router.push('/'),
          )
        }
      >
        {hasOutputs && (
          <div className="flex items-start gap-2.5 rounded-xl border p-3">
            <Checkbox id={deleteId} checked={deleteOutputs} onCheckedChange={(c) => setDeleteOutputs(c === true)} className="mt-0.5" />
            <div className="grid gap-1">
              <Label htmlFor={deleteId}>Also delete the final outputs</Label>
              <p className="text-xs text-muted-foreground">audiobook.mp4, audiobook.m4a and subtitles.srt will be permanently removed.</p>
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

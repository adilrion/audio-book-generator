'use client';

import type { ProjectDetail } from '@app/types';
import { CircleX, Eraser, LoaderCircle, Play, RotateCcw, SlidersHorizontal, Square, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useId, useState } from 'react';
import { ApiErrorAlert, ErrorHint } from '@/components/api-error-alert';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { type ApiError, api, toApiError } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { type Phase, projectError, projectPhase, retryLabel } from '@/lib/stages';

type Action = 'start' | 'retry' | 'restart' | 'cancel' | 'clean' | 'delete';

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
            <div className="grid gap-2">{description}</div>
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
  /** Called after an action changed server state (re-fetch + resume polling). */
  onChanged: () => void;
  /** Informational result, e.g. "Freed 120 MB". */
  onNotice: (message: string) => void;
}

/** Start/Resume, Retry, Cancel, Restart, Clean cache and Delete — with confirmations for the destructive ones. */
export function ProjectActions({ project, onChanged, onNotice }: ProjectActionsProps) {
  const router = useRouter();
  const phase: Phase = projectPhase(project);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<ApiError>();
  const [dialog, setDialog] = useState<'restart' | 'clean' | 'delete' | null>(null);
  const [deleteOutputs, setDeleteOutputs] = useState(false);
  const deleteId = useId();
  const running = phase === 'active' || phase === 'queued';
  const err = projectError(project);

  const run = async (action: Action, fn: () => Promise<unknown>, after?: (r: unknown) => void) => {
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
  };

  const hasOutputs = project.outputs.some((o) => o.kind === 'video' || o.kind === 'audio');

  const retryButton = (
    <Button onClick={() => void run('retry', () => api.retry(project.id))} disabled={!!busy} variant={err?.retryable === false ? 'outline' : 'default'}>
      {busy === 'retry' ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />} {retryLabel(err, project.steps)}
    </Button>
  );

  return (
    <div className="grid gap-3">
      {phase === 'failed' && err && (
        <Alert variant="destructive">
          <CircleX aria-hidden />
          <AlertTitle>{err.message}</AlertTitle>
          <AlertDescription>
            <ErrorHint hint={err.hint} />
            {err.retryable === false && <p>Retrying with the same settings will not fix this — change the settings (or the PDF) first.</p>}
            <div className="mt-2 flex flex-wrap gap-2 text-foreground">
              {err.retryable === false && (
                <Button asChild>
                  <a href="#settings">
                    <SlidersHorizontal aria-hidden /> Review settings
                  </a>
                </Button>
              )}
              {retryButton}
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'idle' && (
          <Button onClick={() => void run('start', () => api.process(project.id))} disabled={!!busy}>
            {busy === 'start' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play aria-hidden />} Start processing
          </Button>
        )}
        {phase === 'cancelled' && (
          <Button onClick={() => void run('start', () => api.process(project.id))} disabled={!!busy}>
            {busy === 'start' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play aria-hidden />} Resume
          </Button>
        )}
        {phase === 'failed' && !err && retryButton}
        {running && (
          <Button variant="outline" onClick={() => void run('cancel', () => api.cancel(project.id))} disabled={!!busy}>
            {busy === 'cancel' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Square className="fill-current" aria-hidden />} Cancel
          </Button>
        )}
        {!running && phase !== 'idle' && (
          <Button variant="outline" onClick={() => setDialog('restart')} disabled={!!busy}>
            <RotateCcw aria-hidden /> Restart
          </Button>
        )}
        {!running && (
          <Button variant="ghost" onClick={() => setDialog('clean')} disabled={!!busy} className="text-muted-foreground">
            <Eraser aria-hidden /> Clean project cache
          </Button>
        )}
        {!running && (
          <Button variant="ghost" onClick={() => setDialog('delete')} disabled={!!busy} className="text-muted-foreground hover:text-destructive">
            <Trash2 aria-hidden /> Delete
          </Button>
        )}
      </div>
      {running && <p className="text-xs text-muted-foreground">Settings, cache cleaning and deletion are available once processing stops.</p>}
      {error && !dialog && <ApiErrorAlert error={error} />}

      <ConfirmDialog
        open={dialog === 'restart'}
        onOpenChange={(o) => {
          setDialog(o ? 'restart' : null);
          setError(undefined);
        }}
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
        onOpenChange={(o) => {
          setDialog(o ? 'clean' : null);
          setError(undefined);
        }}
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
          setDialog(o ? 'delete' : null);
          setDeleteOutputs(false);
          setError(undefined);
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
          <div className="flex items-start gap-2.5 rounded-lg border p-3">
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

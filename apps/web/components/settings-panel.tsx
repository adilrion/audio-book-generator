'use client';

import { STAGE_LABELS, STAGES, type ProjectDetail, type ProjectSettings } from '@app/types';
import { Headphones, Info, LoaderCircle, RefreshCw, Save, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { LookPreview, SettingsForm, validateSettings } from '@/components/settings-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type ApiError, api, type SystemConfig, toApiError } from '@/lib/api';
import { affectedStages, cloneSettings, diffSettings, isEmptyPatch } from '@/lib/settings';
import { type Phase } from '@/lib/stages';
import { cn } from '@/lib/utils';

/**
 * Edit settings after upload or after completion and re-run. The server's content-addressed
 * cache means only the stages that depend on a changed setting are recomputed.
 */
export function SettingsPanel({
  project,
  phase,
  config,
  onChanged,
  onDirtyChange,
}: {
  project: ProjectDetail;
  phase: Phase;
  config?: SystemConfig;
  onChanged: (fresh?: ProjectDetail) => void;
  /** Unsaved edits appeared / were saved or discarded (the tab shows a dot). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const serverJson = JSON.stringify(project.settings);
  const [draft, setDraft] = useState<ProjectSettings>(() => cloneSettings(project.settings));
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [error, setError] = useState<ApiError>();
  const lastServer = useRef(serverJson);

  const patch = useMemo(() => diffSettings(project.settings, draft), [project.settings, draft]);
  const dirty = !isEmptyPatch(patch);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  // Adopt new server settings unless the user has unsaved edits.
  useEffect(() => {
    if (serverJson === lastServer.current) return;
    const prev = JSON.parse(lastServer.current) as ProjectSettings;
    lastServer.current = serverJson;
    setDraft((d) => (isEmptyPatch(diffSettings(prev, d)) ? cloneSettings(project.settings) : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverJson]);

  const running = phase === 'active' || phase === 'queued';
  const invalid = validateSettings(draft);
  const redo = affectedStages(patch, draft);
  const reused = STAGES.filter((s) => !redo.includes(s) && (draft.outputMode === 'audiobook_video' || (s !== 'VIDEO' && s !== 'MUX')));
  const neverRun = phase === 'idle';

  const submit = async (andRun: boolean) => {
    setBusy(andRun ? 'run' : 'save');
    setError(undefined);
    try {
      let fresh: ProjectDetail | undefined;
      if (dirty) fresh = await api.updateSettings(project.id, patch);
      if (andRun) await api.process(project.id);
      if (fresh) {
        lastServer.current = JSON.stringify(fresh.settings);
        setDraft(cloneSettings(fresh.settings));
      }
      onChanged(andRun ? undefined : fresh);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-8">
      <SettingsForm
        value={draft}
        onChange={setDraft}
        config={config}
        disabled={running || !!busy}
        document={project.document}
        chapterCount={project.chapters.length || undefined}
      />

      <aside className="grid gap-4 lg:sticky lg:top-8" aria-label="Apply changes">
        <div className="grid gap-5 rounded-2xl border bg-card p-5 shadow-card">
          <div className="grid gap-3">
            <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Preview</p>
            {draft.outputMode === 'audiobook_video' ? (
              <LookPreview settings={draft} />
            ) : (
              <div className="grid aspect-video place-items-center rounded-xl bg-muted/70 text-muted-foreground">
                <span className="grid justify-items-center gap-2 text-sm">
                  <Headphones className="size-6" aria-hidden /> Audio only — M4A + SRT
                </span>
              </div>
            )}
          </div>

          <div className={cn('grid gap-2 rounded-xl border p-3.5 text-sm', dirty && !running && !invalid && 'border-info/30 bg-info/[0.05]')} aria-live="polite">
            {running ? (
              <p className="text-muted-foreground">Settings can be changed once processing stops.</p>
            ) : invalid && dirty ? (
              <p className="text-destructive">{invalid}</p>
            ) : dirty && !neverRun ? (
              <>
                <p className="font-medium">Will recompute</p>
                <div className="flex flex-wrap gap-1.5">
                  {redo.length ? (
                    redo.map((s) => (
                      <Badge key={s} variant="info">
                        {STAGE_LABELS[s]}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">Nothing — outputs stay as they are.</span>
                  )}
                </div>
                {reused.length > 0 && <p className="text-xs text-muted-foreground">Reused from cache: {reused.map((s) => STAGE_LABELS[s]).join(', ')}.</p>}
              </>
            ) : (
              <p className="flex items-start gap-2 text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {neverRun
                    ? 'Adjust anything you like, then save and start.'
                    : 'Only the stages a change affects are recomputed — a new theme re-renders the video but reuses the narration; a new voice regenerates the audio but keeps the PDF analysis.'}
                </span>
              </p>
            )}
          </div>

          {error && <ApiErrorAlert error={error} title="Could not apply the settings" />}

          <div className="grid gap-2">
            <Button
              size="lg"
              variant={dirty || neverRun ? 'brand' : 'default'}
              onClick={() => void submit(true)}
              disabled={running || !!busy || !!invalid || (!dirty && !neverRun && phase === 'completed')}
              className="w-full"
            >
              {busy === 'run' ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {neverRun ? (dirty ? 'Save & start' : 'Start') : 'Save & re-run'}
            </Button>
            {dirty && (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="ghost" onClick={() => setDraft(cloneSettings(project.settings))} disabled={running || !!busy}>
                  <Undo2 aria-hidden /> Discard
                </Button>
                <Button variant="outline" onClick={() => void submit(false)} disabled={running || !!busy || !!invalid}>
                  {busy === 'save' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />} Save
                </Button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* On small screens the rail is below the whole form — keep unsaved changes one tap away. */}
      {dirty && !running && (
        <div className="sticky bottom-3 z-30 lg:hidden">
          <div className="flex items-center gap-3 rounded-2xl border bg-card/90 p-2.5 pl-4 shadow-float backdrop-blur-md supports-[backdrop-filter]:bg-card/75">
            <p className={cn('min-w-0 flex-1 text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>{invalid ?? 'You have unsaved changes.'}</p>
            <Button size="sm" variant="brand" onClick={() => void submit(true)} disabled={!!busy || !!invalid} className="shrink-0">
              {busy === 'run' ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {neverRun ? 'Save & start' : 'Save & re-run'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

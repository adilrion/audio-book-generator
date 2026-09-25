'use client';

import { STAGE_LABELS, STAGES, type ProjectDetail, type ProjectSettings } from '@app/types';
import { LoaderCircle, RefreshCw, Save, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { SettingsForm, validateSettings } from '@/components/settings-form';
import { Button } from '@/components/ui/button';
import { type ApiError, api, type SystemConfig, toApiError } from '@/lib/api';
import { affectedStages, cloneSettings, diffSettings, isEmptyPatch } from '@/lib/settings';
import { type Phase } from '@/lib/stages';

/**
 * Edit settings after upload or after completion and re-run. The server's content-addressed
 * cache means only the stages that depend on a changed setting are recomputed.
 */
export function SettingsPanel({
  project,
  phase,
  config,
  onChanged,
}: {
  project: ProjectDetail;
  phase: Phase;
  config?: SystemConfig;
  onChanged: (fresh?: ProjectDetail) => void;
}) {
  const serverJson = JSON.stringify(project.settings);
  const [draft, setDraft] = useState<ProjectSettings>(() => cloneSettings(project.settings));
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [error, setError] = useState<ApiError>();
  const lastServer = useRef(serverJson);

  const patch = useMemo(() => diffSettings(project.settings, draft), [project.settings, draft]);
  const dirty = !isEmptyPatch(patch);

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
    <div className="grid gap-6">
      <SettingsForm value={draft} onChange={setDraft} config={config} disabled={running || !!busy} document={project.document} chapterCount={project.chapters.length || undefined} />

      {error && <ApiErrorAlert error={error} title="Could not apply the settings" />}

      <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid min-w-0 gap-1 text-sm">
          {running ? (
            <p className="text-muted-foreground">Settings can be changed once processing stops.</p>
          ) : invalid && dirty ? (
            <p className="text-destructive">{invalid}</p>
          ) : dirty && !neverRun ? (
            <>
              <p>
                <span className="font-medium">Will recompute:</span>{' '}
                {redo.length ? redo.map((s) => STAGE_LABELS[s]).join(', ') : <span className="text-muted-foreground">nothing — outputs stay as they are</span>}
              </p>
              {reused.length > 0 && (
                <p className="text-xs text-muted-foreground">Reused from cache: {reused.map((s) => STAGE_LABELS[s]).join(', ')}.</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              {neverRun
                ? 'Adjust anything you like, then save and start.'
                : 'Change the voice, look or text options and re-run — only the stages affected by your changes are recomputed (a new theme re-renders the video but reuses the narration; a new voice regenerates the audio but keeps the PDF analysis).'}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(cloneSettings(project.settings))} disabled={running || !!busy}>
              <Undo2 aria-hidden /> Discard
            </Button>
          )}
          {dirty && (
            <Button variant="outline" onClick={() => void submit(false)} disabled={running || !!busy || !!invalid}>
              {busy === 'save' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />} Save
            </Button>
          )}
          <Button onClick={() => void submit(true)} disabled={running || !!busy || !!invalid || (!dirty && !neverRun && phase === 'completed')}>
            {busy === 'run' ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {neverRun ? (dirty ? 'Save & start' : 'Start') : 'Save & re-run'}
          </Button>
        </div>
      </div>
    </div>
  );
}

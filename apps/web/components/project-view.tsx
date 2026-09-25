'use client';

import type { ProjectDetail } from '@app/types';
import { ArrowLeft, CircleCheck, Film, Headphones, Info, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { ChaptersList } from '@/components/chapters-list';
import { OutputsList } from '@/components/outputs-list';
import { ProcessingPanel } from '@/components/processing-panel';
import { ProjectActions } from '@/components/project-actions';
import { ReadAlongPlayer } from '@/components/read-along-player';
import { SettingsPanel } from '@/components/settings-panel';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/hooks/use-api';
import { api, outputUrl } from '@/lib/api';
import { formatDate, formatDuration, formatNumber, formatRelative } from '@/lib/format';
import { type Phase, projectPhase } from '@/lib/stages';

const POLL_MS = 1500;

/** Is there a timeline + narration that belong to the current outputs? */
function previewState(p: ProjectDetail, phase: Phase) {
  const tl = p.steps.find((s) => s.key === 'TIMELINE');
  const extract = p.steps.find((s) => s.key === 'EXTRACT');
  const m4a = p.outputs.find((o) => o.name === 'audiobook.m4a');
  const mp4 = p.outputs.find((o) => o.name === 'audiobook.mp4');
  let timelineReady: boolean;
  if (phase === 'active') {
    // Only once this run has rebuilt the timeline (earlier runs' files may be about to be replaced).
    timelineReady = tl?.status === 'COMPLETED' && !!tl.finishedAt && !!extract?.startedAt && tl.finishedAt >= extract.startedAt;
  } else {
    timelineReady = tl ? tl.status === 'COMPLETED' : phase === 'completed'; // steps are cleared by "Clean project cache"
  }
  const ready = !!m4a && timelineReady;
  return {
    ready,
    m4a,
    mp4: phase === 'active' || phase === 'queued' ? undefined : mp4,
    key: ready ? `timeline:${p.id}:${tl?.finishedAt ?? 'final'}:${m4a?.size}` : null,
  };
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap">{children}</span>;
}

function PageSkeleton() {
  return (
    <div className="grid gap-6">
      <Skeleton className="h-4 w-24" />
      <div className="grid gap-2">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <Skeleton className="h-9 w-72" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}

export function ProjectView({ id }: { id: string }) {
  const [pollMs, setPollMs] = useState<number | false>(false);
  const project = useApi(`project:${id}`, (signal) => api.project(id, signal), { interval: pollMs });
  const config = useApi('config', (signal) => api.config(signal));
  const [notice, setNotice] = useState<string>();

  const p = project.data;
  const phase = p ? projectPhase(p) : undefined;

  // Poll every ~1.5 s while queued/processing; stop once COMPLETED / FAILED / CANCELLED (or never started).
  useEffect(() => {
    setPollMs(phase === 'active' || phase === 'queued' ? POLL_MS : false);
  }, [phase]);

  const preview = p && phase ? previewState(p, phase) : undefined;
  const timeline = useApi(preview?.key ?? null, (signal) => api.timeline(id, signal));

  const { refresh, mutate } = project;
  const onChanged = useCallback(
    (fresh?: ProjectDetail) => {
      if (fresh) mutate(fresh);
      setPollMs(POLL_MS); // pick up the new job right away; the effect above stops polling when it ends
      void refresh();
    },
    [mutate, refresh],
  );

  if (project.error && !p) {
    const notFound = project.error.code === 'NOT_FOUND' || project.error.status === 404;
    return (
      <div className="grid gap-6">
        <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> Projects
        </Link>
        <ApiErrorAlert
          error={project.error}
          title={notFound ? 'Project not found' : undefined}
          onRetry={notFound ? undefined : () => void project.refresh()}
          action={
            notFound ? (
              <Button asChild size="sm" variant="outline" className="text-foreground">
                <Link href="/">Back to projects</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (!p || !phase) return <PageSkeleton />;

  const audioOnly = p.settings.outputMode === 'audiobook_only';
  const showPreviewFirst = phase === 'completed' && preview?.ready;

  const previewCard = preview?.ready ? (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <CardDescription>
          {phase === 'active' ? 'The narration is ready — preview it while the video renders.' : 'Listen along with the highlighted page, or watch the final video.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="readalong">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="readalong">
              <Headphones aria-hidden /> Read-along
            </TabsTrigger>
            <TabsTrigger value="video" disabled={!preview.mp4}>
              <Film aria-hidden /> Video{!preview.mp4 && (audioOnly ? ' (audio only)' : ' (not ready)')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="readalong" className="mt-1">
            {timeline.data ? (
              <ReadAlongPlayer
                projectId={p.id}
                timeline={timeline.data}
                audioSrc={outputUrl(p.id, 'audiobook.m4a', { inline: true, v: preview.m4a?.size })}
                highlightStyle={p.settings.video.highlightStyle}
                highlightColor={p.settings.video.highlightColor}
              />
            ) : timeline.error ? (
              <ApiErrorAlert error={timeline.error} title="The preview could not be loaded" onRetry={() => void timeline.refresh()} />
            ) : (
              <Skeleton className="aspect-[16/9] w-full" />
            )}
          </TabsContent>
          <TabsContent value="video" className="mt-1">
            {preview.mp4 && (
              <video
                key={preview.mp4.size}
                controls
                preload="metadata"
                playsInline
                className="mx-auto max-h-[75vh] w-full rounded-lg bg-black"
                style={{ aspectRatio: `${p.settings.video.width} / ${p.settings.video.height}` }}
                src={outputUrl(p.id, 'audiobook.mp4', { inline: true, v: preview.mp4.size })}
              />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  ) : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> Projects
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="grid min-w-0 gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight break-words">{p.name}</h1>
            <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-sm text-muted-foreground tabular">
              <Meta>{p.document.fileName}</Meta>
              <span aria-hidden>·</span>
              <Meta>{formatNumber(p.pageCount)} pages</Meta>
              <span aria-hidden>·</span>
              <Meta>~{formatNumber(p.wordCount)} words</Meta>
              {p.durationSec ? (
                <>
                  <span aria-hidden>·</span>
                  <Meta>{formatDuration(p.durationSec)} narrated</Meta>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <Meta>
                <span title={formatDate(p.createdAt)}>created {formatRelative(p.createdAt)}</span>
              </Meta>
            </p>
          </div>
          <StatusBadge status={p.status} queued={phase === 'queued'} className="mt-1.5" />
        </div>
      </div>

      {project.error && <ApiErrorAlert error={project.error} title="Lost contact with the local API — showing the last known state" />}

      {notice && (
        <Alert variant="success">
          <CircleCheck aria-hidden />
          <AlertDescription className="flex items-center justify-between gap-2 text-foreground">
            <span>{notice}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => setNotice(undefined)} aria-label="Dismiss">
              <X aria-hidden />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <ProjectActions project={p} onChanged={() => onChanged()} onNotice={setNotice} />

      {showPreviewFirst && previewCard}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="gap-4 pb-0">
          <CardHeader>
            <CardTitle>Progress</CardTitle>
            <CardDescription>Every finished step is saved, so an interrupted run resumes where it stopped.</CardDescription>
          </CardHeader>
          <ProcessingPanel project={p} />
        </Card>

        <div className="grid gap-6">
          <Card className="gap-3 pb-0">
            <CardHeader>
              <CardTitle>Export</CardTitle>
              <CardDescription>Final files — never deleted by cache cleaning.</CardDescription>
            </CardHeader>
            <div className="border-t">
              <OutputsList outputs={p.outputs} pending={phase === 'active' || phase === 'queued'} />
            </div>
          </Card>
          <Card className="gap-3 pb-0">
            <CardHeader>
              <CardTitle>Chapters</CardTitle>
              <CardDescription>Detected from the table of contents, headings and patterns.</CardDescription>
            </CardHeader>
            <div className="border-t">
              <ChaptersList chapters={p.chapters} emptyText={phase === 'idle' || phase === 'queued' ? 'Chapters appear after the PDF is analysed.' : 'No chapters yet.'} />
            </div>
          </Card>
        </div>
      </div>

      {!showPreviewFirst && previewCard}

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription className="flex items-start gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Only the stages affected by a change are recomputed server-side; everything else is reused from cache.</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsPanel project={p} phase={phase} config={config.data} onChanged={onChanged} />
        </CardContent>
      </Card>
    </div>
  );
}

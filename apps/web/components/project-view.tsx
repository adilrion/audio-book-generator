'use client';

import type { ProjectDetail } from '@app/types';
import { BookOpen, CircleCheck, Clock, FileText, Film, Headphones, LayoutList, ListChecks, SlidersHorizontal, Type, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { BookCover } from '@/components/book-cover';
import { ChapterReview } from '@/components/chapter-review';
import { ChaptersList } from '@/components/chapters-list';
import { OutputsList } from '@/components/outputs-list';
import { BackLink } from '@/components/page-header';
import { PowerControl } from '@/components/power-control';
import { ProcessingPanel } from '@/components/processing-panel';
import { FailureAlert, ProjectActions, useProjectCommands } from '@/components/project-actions';
import { ReadAlongPlayer } from '@/components/read-along-player';
import { SettingsPanel } from '@/components/settings-panel';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/hooks/use-api';
import { api, outputUrl } from '@/lib/api';
import { formatDate, formatDuration, formatNumber, formatRelative } from '@/lib/format';
import type { ProjectTab } from '@/lib/project-tabs';
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

function Meta({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground/80" title={title}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

function PageSkeleton() {
  return (
    <div className="grid gap-8">
      <Skeleton className="h-4 w-20" />
      <div className="flex items-end gap-6">
        <Skeleton className="aspect-[5/7] w-28 rounded-md" />
        <div className="grid flex-1 gap-3">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="h-96 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    </div>
  );
}

function ListenPlaceholder({ project, phase, onStart }: { project: ProjectDetail; phase: Phase; onStart: () => void }) {
  const working = phase === 'active' || phase === 'queued';
  return (
    <div className="grid justify-items-center gap-5 rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Headphones className="size-6" aria-hidden />
      </span>
      <div className="grid max-w-md gap-1.5">
        <p className="text-[15px] font-medium">The read-along preview appears once the narration is ready</p>
        <p className="text-sm text-muted-foreground">
          {working
            ? 'Narration is being generated — you can preview it here while the video renders.'
            : phase === 'review'
              ? 'Review the chapter list first; narration starts right after.'
              : phase === 'idle'
                ? 'Start processing to narrate the book.'
                : 'Run the project again to create the narration.'}
        </p>
      </div>
      {working && (
        <div className="flex w-full max-w-xs items-center gap-3">
          <Progress value={project.progress} live className="h-1.5" indicatorClassName="bg-info" />
          <span className="text-xs text-muted-foreground tabular">{Math.round(project.progress)}%</span>
        </div>
      )}
      {phase === 'review' && (
        <Button variant="brand" onClick={onStart}>
          Review chapters
        </Button>
      )}
    </div>
  );
}

/** `initialTime` (seconds, from `?t=`) opens the read-along preview at that moment. */
export function ProjectView({ id, initialTime, initialTab }: { id: string; initialTime?: number; initialTab?: ProjectTab }) {
  const [pollMs, setPollMs] = useState<number | false>(false);
  const project = useApi(`project:${id}`, (signal) => api.project(id, signal), { interval: pollMs });
  const config = useApi('config', (signal) => api.config(signal));
  const [notice, setNotice] = useState<string>();
  const [editingChapters, setEditingChapters] = useState(false);
  const [tab, setTabState] = useState<ProjectTab | undefined>(initialTab ?? (initialTime !== undefined ? 'listen' : undefined));
  const [previewMode, setPreviewMode] = useState<'readalong' | 'video'>('readalong');
  const [settingsDirty, setSettingsDirty] = useState(false);

  const p = project.data;
  const phase = p ? projectPhase(p) : undefined;

  // Poll every ~1.5 s while queued/processing; stop once COMPLETED / FAILED / CANCELLED (or never started).
  useEffect(() => {
    setPollMs(phase === 'active' || phase === 'queued' ? POLL_MS : false);
  }, [phase]);

  const preview = p && phase ? previewState(p, phase) : undefined;
  const timeline = useApi(preview?.key ?? null, (signal) => api.timeline(id, signal));

  // The first tab: a finished book opens on its read-along, everything else on the overview. Chosen
  // once, so a book that finishes while you watch doesn't yank you to another tab.
  const defaultTab: ProjectTab = phase === 'completed' && preview?.ready ? 'listen' : 'overview';
  const current = tab ?? defaultTab;
  useEffect(() => {
    if (!tab && phase) setTabState(defaultTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase !== undefined]);

  const setTab = useCallback((t: ProjectTab) => {
    setTabState(t);
    // Keep ?tab= in the address bar (no navigation), so a reload or a shared link opens the same tab.
    const url = new URL(window.location.href);
    if (t === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', t);
    if (t !== 'listen') url.searchParams.delete('t');
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const { refresh, mutate } = project;
  const onChanged = useCallback(
    (fresh?: ProjectDetail) => {
      if (fresh) mutate(fresh);
      setPollMs(POLL_MS); // pick up the new job right away; the effect above stops polling when it ends
      void refresh();
    },
    [mutate, refresh],
  );
  const cmds = useProjectCommands(onChanged);

  const openChapterReview = useCallback(() => {
    if (phase !== 'review') setEditingChapters(true);
    setTab('overview');
    window.setTimeout(() => document.getElementById('chapter-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }, [phase, setTab]);

  if (project.error && !p) {
    const notFound = project.error.code === 'NOT_FOUND' || project.error.status === 404;
    return (
      <div className="grid gap-6">
        <BackLink href="/">Library</BackLink>
        <ApiErrorAlert
          error={project.error}
          title={notFound ? 'Project not found' : undefined}
          onRetry={notFound ? undefined : () => void project.refresh()}
          action={
            notFound ? (
              <Button asChild size="sm" variant="outline" className="text-foreground">
                <Link href="/">Back to the library</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (!p || !phase) return <PageSkeleton />;

  const audioOnly = p.settings.outputMode === 'audiobook_only';
  const running = phase === 'active' || phase === 'queued';
  const author = p.document.author?.trim();

  return (
    <div className="grid gap-8">
      {/* ── Hero ── */}
      <header className="grid animate-rise gap-5">
        <BackLink href="/">Library</BackLink>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-6">
          <div className="flex min-w-0 flex-1 items-start gap-4 sm:items-end sm:gap-6">
            <BookCover projectId={p.id} title={p.name} className="w-20 sm:w-32" />
            <div className="grid min-w-0 flex-1 gap-3">
              <StatusBadge status={p.status} queued={phase === 'queued'} />
              <div className="grid gap-1">
                <h1 className="font-serif text-[1.75rem] leading-[1.1] font-medium tracking-tight text-balance break-words sm:text-[2.5rem]">{p.name}</h1>
                {author && <p className="text-[15px] text-muted-foreground">by {author}</p>}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted-foreground tabular">
                <Meta icon={<FileText aria-hidden />} title={p.document.fileName}>
                  {p.document.fileName}
                </Meta>
                <Meta icon={<BookOpen aria-hidden />}>{formatNumber(p.pageCount)} pages</Meta>
                <Meta icon={<Type aria-hidden />}>~{formatNumber(p.wordCount)} words</Meta>
                {p.durationSec ? <Meta icon={<Headphones aria-hidden />}>{formatDuration(p.durationSec)} narrated</Meta> : null}
                <Meta icon={<Clock aria-hidden />} title={formatDate(p.createdAt)}>
                  Created {formatRelative(p.createdAt)}
                </Meta>
              </div>
            </div>
          </div>
          <ProjectActions project={p} cmds={cmds} onNotice={setNotice} onReviewChapters={openChapterReview} className="sm:justify-end sm:self-end" />
        </div>
      </header>

      {(project.error || notice || (cmds.error && !cmds.dialog) || phase === 'failed') && (
        <div className="grid gap-3">
          {project.error && <ApiErrorAlert error={project.error} title="Lost contact with the local API — showing the last known state" />}
          <FailureAlert project={p} cmds={cmds} onReviewSettings={() => setTab('settings')} />
          {cmds.error && !cmds.dialog && <ApiErrorAlert error={cmds.error} />}
          {notice && (
            <Alert variant="success">
              <CircleCheck aria-hidden />
              <AlertDescription className="flex items-center justify-between gap-2 text-foreground">
                <span>{notice}</span>
                <Button variant="ghost" size="icon-xs" onClick={() => setNotice(undefined)} aria-label="Dismiss">
                  <X aria-hidden />
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <Tabs value={current} onValueChange={(v) => setTab(v as ProjectTab)} className="gap-6">
        <TabsList variant="line" aria-label="Project sections">
          <TabsTrigger value="overview">
            <LayoutList aria-hidden /> Overview
          </TabsTrigger>
          <TabsTrigger value="listen">
            <Headphones aria-hidden /> Read-along
            {preview?.ready && (
              <span className="size-1.5 rounded-full bg-brand" title="Ready to play">
                <span className="sr-only">(ready)</span>
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <SlidersHorizontal aria-hidden /> Settings
            {settingsDirty && (
              <span className="size-1.5 rounded-full bg-info" title="Unsaved changes">
                <span className="sr-only">(unsaved changes)</span>
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Every panel stays mounted: unsaved settings, a chapter review in progress and the player
            position survive switching tabs. */}
        <TabsContent value="overview" forceMount className="grid gap-6 data-[state=inactive]:hidden">
          {(phase === 'review' || editingChapters) && (
            <div id="chapter-review" className="scroll-mt-6">
              <ChapterReview
                key={p.analysisKey}
                project={p}
                onClose={phase === 'review' ? undefined : () => setEditingChapters(false)}
                onStarted={() => {
                  setEditingChapters(false);
                  setNotice('Narration started with the reviewed chapter list.');
                  onChanged();
                }}
              />
            </div>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="gap-6">
              <CardHeader>
                <CardTitle>Progress</CardTitle>
                <CardDescription>Every finished step is saved, so an interrupted run resumes where it stopped.</CardDescription>
              </CardHeader>
              <CardContent>
                <ProcessingPanel project={p} />
              </CardContent>
            </Card>

            <div className="grid gap-6">
              {running && <PowerControl withVideo={!audioOnly} narrationSec={p.durationSec ?? (p.wordCount ? (p.wordCount / 175) * 60 : undefined)} />}
              <Card className="gap-3 pb-0">
                <CardHeader>
                  <CardTitle>Export</CardTitle>
                  <CardDescription>Final files — never deleted by cache cleaning.</CardDescription>
                </CardHeader>
                <div className="border-t">
                  <OutputsList outputs={p.outputs} pending={running} />
                </div>
              </Card>
              {!running && phase !== 'completed' && (
                <PowerControl withVideo={!audioOnly} narrationSec={p.durationSec ?? (p.wordCount ? (p.wordCount / 175) * 60 : undefined)} />
              )}
              <Card className="gap-3 pb-0">
                <CardHeader>
                  <CardTitle>Chapters</CardTitle>
                  <CardDescription>Detected from the table of contents, headings and patterns.</CardDescription>
                  {p.analysisKey && !editingChapters && (phase === 'completed' || phase === 'failed' || phase === 'cancelled') && (
                    <CardAction>
                      <Button size="xs" variant="outline" onClick={openChapterReview}>
                        <ListChecks aria-hidden /> Review
                      </Button>
                    </CardAction>
                  )}
                </CardHeader>
                <div className="border-t">
                  <ChaptersList chapters={p.chapters} emptyText={phase === 'idle' || phase === 'queued' ? 'Chapters appear after the PDF is analysed.' : 'No chapters yet.'} />
                </div>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="listen" forceMount className="data-[state=inactive]:hidden">
          {preview?.ready ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {phase === 'active' ? 'The narration is ready — preview it while the video renders.' : 'Listen along with the highlighted page, or watch the final video.'}
                </p>
                <Segmented value={previewMode} onValueChange={(v) => setPreviewMode(v as 'readalong' | 'video')} aria-label="Preview" className="w-fit">
                  <SegmentedItem value="readalong">
                    <Headphones aria-hidden /> Read-along
                  </SegmentedItem>
                  <SegmentedItem value="video" disabled={!preview.mp4}>
                    <Film aria-hidden /> Video{!preview.mp4 && (audioOnly ? ' (audio only)' : ' (not ready)')}
                  </SegmentedItem>
                </Segmented>
              </div>
              {previewMode === 'video' && preview.mp4 ? (
                <div className="grid place-items-center rounded-2xl bg-stage p-3 sm:p-6">
                  <video
                    key={preview.mp4.size}
                    controls
                    preload="metadata"
                    playsInline
                    className="max-h-[75vh] w-full rounded-lg bg-black shadow-float"
                    style={{ aspectRatio: `${p.settings.video.width} / ${p.settings.video.height}` }}
                    src={outputUrl(p.id, 'audiobook.mp4', { inline: true, v: preview.mp4.size })}
                  />
                </div>
              ) : timeline.data ? (
                <ReadAlongPlayer
                  projectId={p.id}
                  timeline={timeline.data}
                  audioSrc={outputUrl(p.id, 'audiobook.m4a', { inline: true, v: preview.m4a?.size })}
                  highlightStyle={p.settings.video.highlightStyle}
                  highlightColor={p.settings.video.highlightColor}
                  highlightMode={p.settings.video.highlightMode}
                  sentenceTint={p.settings.video.sentenceTint}
                  initialTime={initialTime}
                  active={current === 'listen'}
                />
              ) : timeline.error ? (
                <ApiErrorAlert error={timeline.error} title="The preview could not be loaded" onRetry={() => void timeline.refresh()} />
              ) : (
                <Skeleton className="aspect-[16/9] w-full rounded-2xl" />
              )}
            </div>
          ) : (
            <ListenPlaceholder project={p} phase={phase} onStart={openChapterReview} />
          )}
        </TabsContent>

        <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
          <SettingsPanel project={p} phase={phase} config={config.data} onChanged={onChanged} onDirtyChange={setSettingsDirty} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

'use client';

import type { ChapterEdit, ChapterSummary, ProjectDetail } from '@app/types';
import { Combine, ListChecks, LoaderCircle, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, toApiError } from '@/lib/api';
import { buildChapterEdits, estimateNarrationSec, initialReviewRows, type ReviewRow } from '@/lib/chapter-review';
import { formatDuration, formatNumber } from '@/lib/format';

/**
 * The chapter list before narration starts: keep or leave out chapters, rename them, or merge a
 * chapter into the one before it. Front/back matter is marked, and back matter starts unticked.
 */
export function ChapterReview({ project, onStarted, onClose }: { project: ProjectDetail; onStarted: () => void; onClose?: () => void }) {
  const chapters = useApi(project.analysisKey ? `chapters:${project.id}:${project.analysisKey}` : null, (signal) => api.chapters(project.id, signal));
  const [rows, setRows] = useState<ReviewRow[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();

  useEffect(() => {
    if (chapters.data && !rows) setRows(initialReviewRows(chapters.data, project.settings, project.analysisKey));
  }, [chapters.data, rows, project.settings, project.analysisKey]);

  const byIndex = useMemo(() => new Map((chapters.data ?? []).map((c) => [c.index, c])), [chapters.data]);
  const kept = rows?.filter((r) => r.include) ?? [];
  const words = kept.reduce((n, r) => n + (byIndex.get(r.index)?.wordCount ?? 0), 0);
  const firstKept = kept[0]?.index;

  const set = (index: number, patch: Partial<ReviewRow>) => setRows((rs) => rs?.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  const setAll = (fn: (c: ChapterSummary) => boolean) => setRows((rs) => rs?.map((r) => ({ ...r, include: fn(byIndex.get(r.index)!) })));

  async function start() {
    if (!rows || !chapters.data) return;
    setBusy(true);
    setError(undefined);
    try {
      const items: ChapterEdit[] = buildChapterEdits(rows, chapters.data);
      await api.reviewChapters(project.id, { items });
      onStarted();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-5 border-warning/50 shadow-float ring-4 ring-warning/10">
      <CardHeader className="grid-cols-[auto_1fr] gap-x-3.5">
        <span className="row-span-2 grid size-9 place-items-center rounded-xl bg-warning/20 text-warning-foreground dark:text-warning">
          <ListChecks className="size-[18px]" aria-hidden />
        </span>
        <CardTitle className="text-base">Review chapters</CardTitle>
        <CardDescription className="max-w-3xl">
          Check the detected chapters before narration starts. Untick what should not be read, fix titles, or merge a chapter into the one before it. Only
          the chapters you change are narrated again later.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {chapters.error && <ApiErrorAlert error={chapters.error} title="The chapter list could not be loaded" onRetry={() => void chapters.refresh()} />}
        {!rows ? (
          !chapters.error && (
            <div className="grid gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-3.5 py-2 text-sm">
              <p className="text-muted-foreground tabular">
                <span className="font-medium text-foreground">
                  {kept.length} of {rows.length}
                </span>{' '}
                chapters · ~{formatNumber(words)} words · ≈ {formatDuration(estimateNarrationSec(words, project.settings.tts.speed))} of narration
              </p>
              <div className="flex gap-1">
                <Button size="xs" variant="ghost" onClick={() => setAll(() => true)}>
                  Select all
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setAll((c) => !c.matter)}>
                  Chapters only
                </Button>
              </div>
            </div>
            <ol className="max-h-[32rem] divide-y overflow-y-auto rounded-xl border scrollbar-thin">
              {rows.map((r) => {
                const c = byIndex.get(r.index)!;
                const mergeable = r.include && firstKept !== undefined && r.index !== firstKept;
                return (
                  <li key={r.index} className={`grid gap-1.5 px-3 py-3 transition-colors sm:px-4 ${r.include ? '' : 'bg-muted/50 [&_input]:text-muted-foreground'}`}>
                    <div className="flex items-center gap-2.5">
                      <Checkbox
                        id={`ch-${r.index}`}
                        checked={r.include}
                        onCheckedChange={(v) => set(r.index, { include: v === true })}
                        aria-label={`Narrate chapter ${r.index + 1}`}
                      />
                      <span className="w-6 shrink-0 text-xs text-muted-foreground tabular">{r.index + 1}</span>
                      <Input
                        value={r.title}
                        onChange={(e) => set(r.index, { title: e.target.value })}
                        disabled={!r.include}
                        aria-label={`Title of chapter ${r.index + 1}`}
                        className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 font-medium shadow-none hover:border-input focus-visible:border-ring dark:bg-transparent"
                        maxLength={200}
                      />
                      {c.matter && (
                        <Badge variant="muted" className="hidden shrink-0 sm:inline-flex">
                          {c.matter === 'front' ? 'Front matter' : 'Back matter'}
                        </Badge>
                      )}
                      <Button
                        size="icon-sm"
                        variant={r.merge ? 'secondary' : 'ghost'}
                        disabled={!mergeable}
                        onClick={() => set(r.index, { merge: !r.merge })}
                        aria-pressed={r.merge}
                        aria-label={`Merge chapter ${r.index + 1} into the previous chapter`}
                        title="Merge into the previous chapter"
                      >
                        <Combine aria-hidden />
                      </Button>
                    </div>
                    <p className="pl-[3.25rem] text-xs text-muted-foreground">
                      <span className="tabular">
                        {c.pageStart === c.pageEnd ? `p. ${c.pageStart}` : `pp. ${c.pageStart}–${c.pageEnd}`} · {formatNumber(c.wordCount ?? 0)} words
                      </span>
                      {r.merge && r.include && <span className="font-medium text-foreground"> · merged into the previous chapter</span>}
                      {c.preview && <span className="mt-0.5 line-clamp-2 block break-words">{c.preview}</span>}
                    </p>
                  </li>
                );
              })}
            </ol>
            {error && <ApiErrorAlert error={error} title="Could not start narration" />}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {onClose && (
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
              )}
              <Button variant="brand" onClick={() => void start()} disabled={busy || kept.length === 0}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play aria-hidden />}
                {kept.length === 0 ? 'Keep at least one chapter' : `Narrate ${kept.length} chapter${kept.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

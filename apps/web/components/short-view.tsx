'use client';

import { type ShortDetail, suggestShortTags } from '@app/types';
import { CircleCheck, Download, FileText, LoaderCircle, Pencil, Play, RotateCcw, Square, Trash2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { ShortEditor } from '@/components/short-editor';
import { ShortPreview } from '@/components/short-preview';
import { ShortThumbnailDesigner } from '@/components/short-thumbnail';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, pageImageUrl, shortOutputUrl, toApiError } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/format';
import { formatTags, isShortBusy, youtubeDescription } from '@/lib/shorts';

function CopyBlock({ label, text, children }: { label: string; text: string; children?: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap">{children ?? (text || <span className="text-muted-foreground">—</span>)}</div>
    </div>
  );
}

/** A file name for the upload: "Tagore’s saddest story.mp4". */
const uploadName = (title: string) => title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'short';

export function ShortView({ id }: { id: string }) {
  const router = useRouter();
  const [poll, setPoll] = useState<number | false>(2000);
  const short = useApi(`short:${id}`, (signal) => api.short(id, signal), { interval: poll });
  const s = short.data;
  const busy = s ? isShortBusy(s.status, s.queued) : false;
  useEffect(() => setPoll(busy ? 1500 : false), [busy]);

  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState<'render' | 'cancel' | 'delete'>();
  const [error, setError] = useState<ApiError>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const act = async (what: 'render' | 'cancel' | 'delete', fn: () => Promise<unknown>) => {
    setActing(what);
    setError(undefined);
    try {
      await fn();
      if (what === 'delete') return router.push('/shorts');
      setPoll(1500);
      await short.refresh();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setActing(undefined);
    }
  };

  if (!s) {
    return short.error ? (
      <ApiErrorAlert error={short.error} onRetry={() => void short.refresh()} />
    ) : (
      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]" aria-hidden>
        <Skeleton className="aspect-[9/16] rounded-2xl" />
        <div className="grid content-start gap-3">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-24" />
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="grid gap-8">
        <PageHeader back={{ href: `/shorts/${s.id}`, label: s.title }} title="Edit short" description="Changing only the look re-renders the video without narrating again." />
        <ShortEditor
          initial={s}
          onCancel={() => setEditing(false)}
          onSaved={(d) => {
            short.mutate(d);
            setEditing(false);
            setPoll(1500);
          }}
        />
      </div>
    );
  }

  const video = s.outputs.find((o) => o.name === 'short.mp4');
  const srt = s.outputs.find((o) => o.name === 'short.srt');
  const coverUrl = s.projectId ? pageImageUrl(s.projectId, 1) : undefined;
  const failed = s.status === 'FAILED';
  // Shorts saved before tags existed: suggest them (saved with the next edit).
  const tags = s.tags.length ? s.tags : suggestShortTags({ title: s.title, hashtags: s.hashtags, bookTitle: s.bookTitle, author: s.bookAuthor, language: s.language });

  return (
    <div className="grid gap-8">
      <PageHeader
        back={{ href: '/shorts', label: 'Shorts' }}
        title={s.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s.status} queued={s.queued} />
            {s.durationSec !== undefined && <span className="tabular">{formatDuration(s.durationSec)}</span>}
            {s.bookTitle && <span>· from “{s.bookTitle}”</span>}
          </span>
        }
        actions={
          <>
            {busy ? (
              <Button variant="outline" onClick={() => void act('cancel', () => api.cancelShort(s.id))} disabled={!!acting}>
                {acting === 'cancel' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Square className="fill-current" aria-hidden />} Cancel
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil aria-hidden /> Edit
                </Button>
                <Button variant={video && !s.stale ? 'outline' : 'brand'} onClick={() => void act('render', () => api.renderShort(s.id))} disabled={!!acting || !s.script.trim()}>
                  {acting === 'render' ? <LoaderCircle className="animate-spin" aria-hidden /> : video ? <RotateCcw aria-hidden /> : <Play className="fill-current" aria-hidden />}
                  {video ? 'Render again' : 'Render'}
                </Button>
              </>
            )}
            {video && !busy && (
              <Button asChild variant="brand">
                <a href={shortOutputUrl(s.id, 'short.mp4', { as: uploadName(s.title), v: s.version })} download>
                  <Download aria-hidden /> Download MP4
                </a>
              </Button>
            )}
          </>
        }
      />

      {error && <ApiErrorAlert error={error} />}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <div className="grid gap-3">
          {video && !busy ? (
            <video
              key={s.version}
              src={shortOutputUrl(s.id, 'short.mp4', { inline: true, v: s.version })}
              controls
              playsInline
              className="aspect-[9/16] w-full rounded-2xl bg-black shadow-book"
            />
          ) : (
            <div className="relative">
              <ShortPreview title={s.title} script={s.script} settings={s.settings} coverUrl={coverUrl} className={busy ? 'opacity-60' : undefined} />
              {busy && (
                <div className="absolute inset-x-4 bottom-4 grid gap-2 rounded-xl bg-black/70 p-3 text-white backdrop-blur-sm" aria-live="polite">
                  <Progress value={s.progress * 100} live className="h-1.5 bg-white/20" />
                  <p className="flex items-center gap-1.5 text-xs">
                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> {s.message ?? 'Working…'}
                  </p>
                </div>
              )}
            </div>
          )}
          {s.stale && !busy && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden /> The script or look changed since this video was made. Render again to update it.
            </p>
          )}
          {video && !busy && !s.stale && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck className="size-3.5 text-success" aria-hidden /> 1080 × 1920 · {formatBytes(video.size)} · ready to upload as a Short
            </p>
          )}
        </div>

        <div className="grid min-w-0 gap-6">
          {failed && s.error && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden />
              <AlertTitle>{s.error.message}</AlertTitle>
              {s.error.hint && <AlertDescription>{s.error.hint}</AlertDescription>}
            </Alert>
          )}
          <section className="grid gap-4 rounded-2xl border bg-card p-5 shadow-card">
            <h2 className="text-[15px] font-semibold tracking-tight">Upload to YouTube</h2>
            <ol className="grid gap-1.5 text-sm text-muted-foreground">
              <li>
                1. Download the MP4{s.thumbnailVersion ? ' and the thumbnail' : ', and save a thumbnail below'}. Vertical videos up to 3 minutes become Shorts automatically.
              </li>
              <li>2. In YouTube Studio → Create → Upload videos (or the YouTube app → + → Short), paste the title, description and tags below.</li>
              <li>
                3. Thumbnail: upload thumbnail.jpg where YouTube offers a custom thumbnail for your Short; in the YouTube app you pick the cover from the video’s frames — turn on
                “Open the video with the thumbnail” so it is one of them.
              </li>
            </ol>
            <CopyBlock label="Title" text={s.title} />
            <CopyBlock label="Description" text={youtubeDescription(s.description, s.hashtags)} />
            <CopyBlock label="Tags" text={formatTags(tags)}>
              {tags.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <span key={t} className="rounded-md bg-background px-1.5 py-0.5 text-xs ring-1 ring-border">
                      {t}
                    </span>
                  ))}
                </span>
              ) : undefined}
            </CopyBlock>
            {srt && (
              <a href={shortOutputUrl(s.id, 'short.srt', { as: uploadName(s.title), v: s.version })} download className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                <FileText className="size-4" aria-hidden /> Subtitles (SRT) for YouTube captions
              </a>
            )}
          </section>
          <ShortThumbnailDesigner key={s.id} short={s} busy={busy} onChange={(d) => short.mutate(d)} />
          <section className="grid gap-2 rounded-2xl border bg-card p-5 shadow-card">
            <h2 className="text-[15px] font-semibold tracking-tight">Script</h2>
            <p className="text-sm leading-relaxed whitespace-pre-wrap" lang={s.language}>
              {s.script || <span className="text-muted-foreground">No script yet — click Edit.</span>}
            </p>
          </section>
          <div>
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={busy || !!acting}>
              <Trash2 aria-hidden /> Delete short
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={(o) => acting !== 'delete' && setConfirmDelete(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this short?</DialogTitle>
            <DialogDescription>The video, subtitles and script are removed from this Mac. Videos you already uploaded to YouTube stay there.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={acting === 'delete'}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={() => void act('delete', () => api.deleteShort(s.id))} disabled={acting === 'delete'}>
              {acting === 'delete' && <LoaderCircle className="animate-spin" aria-hidden />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

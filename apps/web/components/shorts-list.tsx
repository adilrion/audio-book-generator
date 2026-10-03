'use client';

import type { ShortSummary, ShortsDeleteResult } from '@app/types';
import { Check, CheckCheck, Clapperboard, Layers, LoaderCircle, Plus, SquareCheck, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, shortOutputUrl, toApiError } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/format';
import { SHORT_THEMES, isShortBusy } from '@/lib/shorts';
import { cn } from '@/lib/utils';

/** A short in the grid: opens the short, or — while selecting — toggles it. */
function ShortCard({ s, highlight, selecting, checked, onToggle }: { s: ShortSummary; highlight?: boolean; selecting?: boolean; checked?: boolean; onToggle?: () => void }) {
  const t = SHORT_THEMES[s.theme] ?? SHORT_THEMES.midnight;
  const busy = isShortBusy(s.status, s.queued);
  const className = 'group grid w-full gap-2.5 rounded-lg text-left ring-offset-4 ring-offset-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60';
  const inner = (
    <>
      <span
        className={cn(
          'relative aspect-[9/16] overflow-hidden rounded-xl shadow-book transition-[transform,opacity] duration-300 group-hover:-translate-y-0.5',
          highlight && !selecting && 'ring-2 ring-brand ring-offset-2 ring-offset-background',
          selecting && checked && 'ring-[3px] ring-destructive ring-offset-2 ring-offset-background',
          selecting && !checked && 'opacity-75 group-hover:opacity-100',
        )}
        style={{ background: `linear-gradient(180deg, ${t.top}, ${t.bottom})` }}
      >
        {s.thumbnailVersion ? (
          // eslint-disable-next-line @next/next/no-img-element -- the saved thumbnail from the local API
          <img src={shortOutputUrl(s.id, 'thumbnail.jpg', { inline: true, v: s.thumbnailVersion })} alt="" className="absolute inset-0 size-full object-cover" />
        ) : s.status === 'COMPLETED' && s.version ? (
          <video src={`${shortOutputUrl(s.id, 'short.mp4', { inline: true, v: s.version })}#t=1.5`} muted playsInline preload="metadata" className="absolute inset-0 size-full object-cover" aria-hidden />
        ) : (
          <span className="absolute inset-x-[10%] top-1/2 -translate-y-1/2 text-center font-serif text-lg leading-snug font-medium text-balance text-white/90 [text-shadow:0_1px_8px_rgb(0_0_0/0.4)]">
            {s.title}
          </span>
        )}
        {busy && (
          <span className="absolute inset-x-3 bottom-3">
            <Progress value={s.progress * 100} live className="h-1.5 bg-white/25" />
          </span>
        )}
        {s.durationSec !== undefined && s.status === 'COMPLETED' && (
          <span className="absolute right-2 bottom-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white tabular">{formatDuration(s.durationSec)}</span>
        )}
        {selecting && (
          <span
            className={cn(
              'absolute top-2 left-2 grid size-6 place-items-center rounded-md border-2 shadow-sm transition-colors',
              checked ? 'border-destructive bg-destructive text-white' : 'border-white/80 bg-black/30 text-transparent backdrop-blur-sm',
            )}
            aria-hidden
          >
            <Check className="size-4" strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="grid gap-1">
        <span className="line-clamp-2 text-sm leading-snug font-medium">{s.title}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={s.status} queued={s.queued} className="px-1.5 py-0 text-[11px]" />
          {s.bookTitle && <span className="truncate text-xs text-muted-foreground">{s.bookTitle}</span>}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {selecting ? (
        <button type="button" role="checkbox" aria-checked={!!checked} onClick={onToggle} className={className}>
          {inner}
        </button>
      ) : (
        <Link href={`/shorts/${s.id}`} className={className}>
          {inner}
        </Link>
      )}
    </li>
  );
}

/** How a batch that was just created is getting on: the worker renders its shorts one after another. */
function BatchBanner({ ids, shorts, onSelect }: { ids: string[]; shorts: ShortSummary[]; onSelect: (ids: string[]) => void }) {
  const router = useRouter();
  const mine = ids.flatMap((id) => shorts.filter((s) => s.id === id));
  if (!mine.length) return null;
  const done = mine.filter((s) => s.status === 'COMPLETED').length;
  const failed = mine.filter((s) => s.status === 'FAILED' || s.status === 'CANCELLED').length;
  const working = mine.filter((s) => isShortBusy(s.status, s.queued));
  const now = mine.find((s) => s.status === 'GENERATING_AUDIO' || s.status === 'RENDERING');
  const drafts = mine.filter((s) => s.status === 'PENDING' && !s.queued).length;
  const n = mine.length;
  const title = working.length
    ? `Rendering your batch — ${done} of ${n} ready`
    : drafts === n
      ? `${n} ${n === 1 ? 'draft' : 'drafts'} saved`
      : `Your batch is done — ${done} of ${n} ready${failed ? `, ${failed} failed` : ''}`;
  const detail = working.length
    ? `${now ? `Now: “${now.title}”. ` : ''}One at a time in the background — you can keep working or leave this page.`
    : drafts === n
      ? 'Open a short to check it and render it.'
      : failed
        ? 'Open a failed short to see why and render it again.'
        : 'Open each one to download it, design its thumbnail and copy its YouTube text.';
  return (
    <section className="grid gap-3 rounded-2xl border bg-card p-4 shadow-card sm:p-5" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand text-brand-foreground">
          <Layers className="size-4" aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onSelect(mine.map((s) => s.id))}>
          <SquareCheck aria-hidden /> <span className="hidden sm:inline">Select batch</span>
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => router.replace('/shorts')} aria-label="Hide batch progress">
          <X aria-hidden />
        </Button>
      </div>
      {working.length > 0 && <Progress value={((done + failed + (now?.progress ?? 0)) / (n - drafts || 1)) * 100} live className="h-1.5" />}
    </section>
  );
}

/** /shorts — every short, newest first; `batch` follows a batch that was just created. */
export function ShortsList({ batch = [] }: { batch?: string[] }) {
  const shorts = useApi('shorts', (signal) => api.shorts(signal), { interval: 4000 });
  const list = shorts.data ?? [];
  const inBatch = new Set(batch);

  // ── select & delete ──
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError>();
  const [done, setDone] = useState<ShortsDeleteResult>();
  const chosen = list.filter((s) => selected.has(s.id));
  const busyChosen = chosen.filter((s) => s.status === 'GENERATING_AUDIO' || s.status === 'RENDERING').length;
  const startSelecting = (ids: string[] = []) => {
    setSelecting(true);
    setSelected(new Set(ids));
    setDone(undefined);
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !confirming && stopSelecting();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, confirming]);
  const remove = async () => {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const r = await api.deleteShorts([...selected]);
      setDone(r);
      setConfirming(false);
      setSelected(new Set(r.skipped.map((s) => s.id)));
      if (!r.skipped.length) setSelecting(false);
      await shorts.refresh();
    } catch (e) {
      setDeleteError(toApiError(e));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Shorts"
        description="Vertical YouTube Shorts with a local voice and word-by-word captions. Paste a script or let the local AI write one — from a topic or one of your books."
        actions={
          <>
            {list.length > 0 && !selecting && (
              <Button variant="ghost" onClick={() => startSelecting()}>
                <SquareCheck aria-hidden /> Select
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href="/shorts/batch">
                <Layers aria-hidden /> New batch
              </Link>
            </Button>
            <Button asChild variant="brand">
              <Link href="/shorts/new">
                <Plus aria-hidden /> New short
              </Link>
            </Button>
          </>
        }
      />
      {done && (
        <Notice onClose={() => setDone(undefined)} tone={done.skipped.length ? 'warning' : 'ok'}>
          {done.deleted.length > 0 && (
            <>
              Deleted {plural(done.deleted.length, 'short')} with {done.deleted.length === 1 ? 'its video' : 'their videos'} and cached narration — {formatBytes(done.freedBytes)} freed.{' '}
            </>
          )}
          {done.skipped.length > 0 && <>{plural(done.skipped.length, 'short')} still stopping and kept — select them and try again in a moment.</>}
        </Notice>
      )}
      {batch.length > 0 && !selecting && <BatchBanner ids={batch} shorts={list} onSelect={startSelecting} />}
      {shorts.error && !shorts.data && <ApiErrorAlert error={shorts.error} onRetry={() => void shorts.refresh()} />}
      {shorts.loading && !shorts.data ? (
        <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="grid gap-2.5">
              <Skeleton className="aspect-[9/16] rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
            </li>
          ))}
        </ul>
      ) : list.length ? (
        <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((s) => (
            <ShortCard key={s.id} s={s} highlight={inBatch.has(s.id)} selecting={selecting} checked={selected.has(s.id)} onToggle={() => toggle(s.id)} />
          ))}
        </ul>
      ) : (
        shorts.data && (
          <section className="grid justify-items-center gap-4 rounded-3xl border bg-card px-6 py-14 text-center shadow-card">
            <span className="grid size-14 place-items-center rounded-2xl bg-brand text-brand-foreground shadow-book">
              <Clapperboard className="size-6" aria-hidden />
            </span>
            <h2 className="font-serif text-2xl font-medium tracking-tight">Make your first Short</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              A 30–60 second vertical video: your script read by a local voice, with big captions that light up word by word. Great for teasers of your audiobooks.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild variant="brand" size="lg">
                <Link href="/shorts/new">
                  <Plus aria-hidden /> New short
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link href="/shorts/batch">
                  <Layers aria-hidden /> Several at once
                </Link>
              </Button>
            </div>
          </section>
        )
      )}
      {selecting && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-2xl border bg-card/95 p-2 pl-4 shadow-lg backdrop-blur-md" role="toolbar" aria-label="Selected shorts">
          <span className="mr-auto text-sm font-medium tabular" aria-live="polite">
            {selected.size ? `${selected.size} selected` : 'Select shorts to delete'}
          </span>
          {selected.size < list.length ? (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(list.map((s) => s.id)))}>
              <CheckCheck aria-hidden /> All {list.length}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={stopSelecting}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={() => (setDeleteError(undefined), setConfirming(true))} disabled={!selected.size}>
            <Trash2 aria-hidden /> Delete{selected.size ? ` ${selected.size}` : ''}
          </Button>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={(open) => !deleting && setConfirming(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {plural(chosen.length, 'short')}?</DialogTitle>
            <DialogDescription>
              {chosen.length === 1 ? 'Its video, thumbnail, subtitles and cached narration are' : 'Their videos, thumbnails, subtitles and cached narration are'} removed from this Mac. This cannot be undone — download any video you want to keep first.
            </DialogDescription>
          </DialogHeader>
          <ul className="grid max-h-48 gap-1 overflow-y-auto rounded-lg bg-muted/50 p-2 text-sm">
            {chosen.map((s) => (
              <li key={s.id} className="flex min-w-0 items-center gap-2">
                <span className="truncate">{s.title}</span>
                {isShortBusy(s.status, s.queued) && <StatusBadge status={s.status} queued={s.queued} className="ml-auto shrink-0 px-1.5 py-0 text-[11px]" />}
              </li>
            ))}
          </ul>
          {busyChosen > 0 && <p className="text-xs text-muted-foreground">{plural(busyChosen, 'short')} still rendering {busyChosen === 1 ? 'is' : 'are'} stopped first.</p>}
          {deleteError && <ApiErrorAlert error={deleteError} title="The shorts could not be deleted" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={deleting}>
              Keep them
            </Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={deleting || !chosen.length}>
              {deleting ? <LoaderCircle className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />} Delete {plural(chosen.length, 'short')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Notice({ tone, onClose, children }: { tone: 'ok' | 'warning'; onClose: () => void; children: ReactNode }) {
  return (
    <p
      className={cn('flex items-start gap-2 rounded-xl border px-4 py-3 text-sm', tone === 'ok' ? 'bg-card' : 'border-warning/40 bg-warning/10')}
      role="status"
    >
      <Check className={cn('mt-0.5 size-4 shrink-0', tone === 'ok' ? 'text-success' : 'text-warning')} aria-hidden />
      <span className="flex-1">{children}</span>
      <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
        <X className="size-4" aria-hidden />
      </button>
    </p>
  );
}

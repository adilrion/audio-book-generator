'use client';

import type { ShortSummary } from '@app/types';
import { Clapperboard, Layers, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { api, shortOutputUrl } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { SHORT_THEMES, isShortBusy } from '@/lib/shorts';
import { cn } from '@/lib/utils';

function ShortCard({ s, highlight }: { s: ShortSummary; highlight?: boolean }) {
  const t = SHORT_THEMES[s.theme] ?? SHORT_THEMES.midnight;
  const busy = isShortBusy(s.status, s.queued);
  return (
    <li>
      <Link href={`/shorts/${s.id}`} className="group grid gap-2.5 rounded-lg ring-offset-4 ring-offset-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60">
        <span
          className={cn('relative aspect-[9/16] overflow-hidden rounded-xl shadow-book transition-transform duration-300 group-hover:-translate-y-0.5', highlight && 'ring-2 ring-brand ring-offset-2 ring-offset-background')}
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
        </span>
        <span className="grid gap-1">
          <span className="line-clamp-2 text-sm leading-snug font-medium">{s.title}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={s.status} queued={s.queued} className="px-1.5 py-0 text-[11px]" />
            {s.bookTitle && <span className="truncate text-xs text-muted-foreground">{s.bookTitle}</span>}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** How a batch that was just created is getting on: the worker renders its shorts one after another. */
function BatchBanner({ ids, shorts }: { ids: string[]; shorts: ShortSummary[] }) {
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
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Shorts"
        description="Vertical YouTube Shorts with a local voice and word-by-word captions. Paste a script or let the local AI write one — from a topic or one of your books."
        actions={
          <>
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
      {batch.length > 0 && <BatchBanner ids={batch} shorts={list} />}
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
            <ShortCard key={s.id} s={s} highlight={inBatch.has(s.id)} />
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
    </div>
  );
}

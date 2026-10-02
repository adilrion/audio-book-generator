'use client';

import type { ProjectSummary } from '@app/types';
import { ChevronRight, FileText, Globe, Headphones, LayoutGrid, List, Plus, Search, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { isTypingTarget } from '@/components/app-shell';
import { useAppState } from '@/components/app-state';
import { AudioBars } from '@/components/audio-bars';
import { BookCover } from '@/components/book-cover';
import { HealthBanner } from '@/components/health-banner';
import { PageHeader } from '@/components/page-header';
import { StatusBadge, StatusDot, statusLabel } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Progress } from '@/components/ui/progress';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, formatDate, formatDuration, formatNumber, formatRelative } from '@/lib/format';
import { isActive } from '@/lib/stages';

type Filter = 'all' | 'progress' | 'attention' | 'done';

const needsAttention = (p: ProjectSummary) => p.status === 'FAILED' || p.status === 'AWAITING_REVIEW';

const FILTERS: { value: Filter; label: string; match: (p: ProjectSummary) => boolean }[] = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'progress', label: 'In progress', match: (p) => p.status !== 'COMPLETED' && !needsAttention(p) },
  { value: 'attention', label: 'Needs attention', match: needsAttention },
  { value: 'done', label: 'Completed', match: (p) => p.status === 'COMPLETED' },
];

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Grid or list, remembered per browser. */
function useLibraryView() {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  useEffect(() => {
    try {
      const v = localStorage.getItem('library:view');
      if (v === 'grid' || v === 'list') setView(v);
    } catch {
      // storage unavailable (private window) — keep the default
    }
  }, []);
  const set = (v: 'grid' | 'list') => {
    setView(v);
    try {
      localStorage.setItem('library:view', v);
    } catch {
      // ignore
    }
  };
  return [view, set] as const;
}

// ─────────────────────────────── empty state ───────────────────────────────

function HeroIllustration() {
  return (
    <div className="relative mx-auto mb-10 h-40 w-36" aria-hidden>
      <div className="absolute inset-0 -rotate-[8deg] rounded-md border bg-card shadow-book" />
      <div className="absolute inset-0 rotate-[4deg] rounded-md border bg-card p-4 shadow-book-lift">
        <div className="grid gap-[7px]">
          <span className="h-[5px] w-2/3 rounded-full bg-foreground/70" />
          <span className="mt-2 h-[4px] w-full rounded-full bg-foreground/15" />
          <span className="h-[4px] w-11/12 rounded-full bg-foreground/15" />
          <span className="relative h-[4px] w-full rounded-full bg-foreground/25">
            <span className="absolute -inset-x-1 -inset-y-[3px] rounded-[3px] bg-brand/80 mix-blend-multiply dark:mix-blend-normal dark:bg-brand/45" />
          </span>
          <span className="h-[4px] w-10/12 rounded-full bg-foreground/15" />
          <span className="h-[4px] w-full rounded-full bg-foreground/15" />
          <span className="h-[4px] w-3/5 rounded-full bg-foreground/15" />
        </div>
      </div>
      <span className="absolute -right-5 -bottom-3 grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-float">
        <AudioBars />
      </span>
    </div>
  );
}

const STEPS = [
  { title: 'Upload a PDF', text: 'Text PDFs are read directly; scanned pages go through OCR.' },
  { title: 'Pick a voice and a look', text: 'Local neural voices, highlight colour, format and theme.' },
  { title: 'Get MP4, M4A and SRT', text: 'A read-along video with chapters, the audiobook and subtitles.' },
];

function EmptyState() {
  return (
    <section className="animate-rise overflow-hidden rounded-3xl border bg-card px-6 py-14 text-center shadow-card sm:px-10 sm:py-16">
      <HeroIllustration />
      <h2 className="mx-auto max-w-xl font-serif text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
        Turn any PDF into a <span className="marker">read-along</span> audiobook
      </h2>
      <p className="mx-auto mt-3 max-w-lg text-[15px] text-muted-foreground">
        Narrated with local voices and highlighted sentence by sentence — made entirely on this Mac, ready for YouTube.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button asChild size="lg" variant="brand">
          <Link href="/new">
            <Upload aria-hidden /> Upload a PDF
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/discover">
            <Globe aria-hidden /> Find a free book
          </Link>
        </Button>
      </div>
      <ol className="mx-auto mt-12 grid max-w-3xl gap-3 text-left sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid gap-1 rounded-2xl border bg-background/60 p-4">
            <span className="grid size-6 place-items-center rounded-full bg-foreground text-xs font-semibold text-background tabular">{i + 1}</span>
            <p className="mt-2 text-sm font-medium">{s.title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid gap-3">
          <Skeleton className="aspect-[5/7] w-full rounded-md" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────── now processing ───────────────────────────────

function NowProcessing({ projects, paused }: { projects: ProjectSummary[]; paused: boolean }) {
  return (
    <section aria-labelledby="now-processing" className="grid gap-3">
      <h2 id="now-processing" className="flex items-center gap-2 text-sm font-medium">
        <AudioBars paused={paused} className="text-info" />
        {paused ? 'Processing paused' : 'Now processing'}
      </h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${p.id}`}
              className="group flex items-center gap-4 rounded-2xl border bg-card p-3 pr-4 shadow-card transition-[box-shadow,border-color] outline-none hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <BookCover projectId={p.id} title={p.name} className="w-12" />
              <div className="grid min-w-0 flex-1 gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate font-serif text-[17px] font-medium">{p.name}</p>
                  <span className="text-lg font-semibold tracking-tight tabular">
                    {Math.round(p.progress)}
                    <span className="text-xs font-medium text-muted-foreground">%</span>
                  </span>
                </div>
                <Progress value={p.progress} live={!paused} className="h-1.5" indicatorClassName="bg-info" />
                <p className="text-xs text-muted-foreground">{paused ? 'Paused — progress is kept' : `${statusLabel(p.status)}…`}</p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────── grid & list ───────────────────────────────

function BookTile({ p, now }: { p: ProjectSummary; now: number }) {
  const working = isActive(p.status);
  return (
    <li>
      <Link
        href={`/projects/${p.id}`}
        className="group grid gap-3 rounded-lg ring-offset-4 ring-offset-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60"
      >
        <div className="relative">
          <BookCover projectId={p.id} title={p.name} className="w-full transition-[transform,box-shadow] duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-book-lift" />
          {p.status !== 'COMPLETED' && (
            <span className="absolute top-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-medium shadow-sm backdrop-blur transition-transform duration-300 group-hover:-translate-y-1">
              <StatusDot status={p.status} className="size-1.5 [&>span]:size-1.5" />
              <span className="truncate">{statusLabel(p.status)}</span>
            </span>
          )}
          {working && (
            <div className="absolute inset-x-2 bottom-2 transition-transform duration-300 group-hover:-translate-y-1">
              <Progress value={p.progress} live className="h-1 bg-black/25" indicatorClassName="bg-info" />
            </div>
          )}
          {p.status === 'COMPLETED' && p.durationSec ? (
            <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white tabular backdrop-blur transition-transform duration-300 group-hover:-translate-y-1">
              <Headphones className="size-3" aria-hidden /> {formatClock(p.durationSec)}
            </span>
          ) : null}
        </div>
        <div className="grid gap-0.5 px-0.5">
          <p className="line-clamp-2 font-serif text-[16px] leading-snug font-medium group-hover:underline group-hover:decoration-foreground/30 group-hover:underline-offset-4" title={p.name}>
            {p.name}
          </p>
          <p className="truncate text-xs text-muted-foreground tabular" title={formatDate(p.createdAt)}>
            {formatNumber(p.pageCount)} pages · {formatRelative(p.createdAt, now)}
          </p>
        </div>
      </Link>
    </li>
  );
}

function NewTile() {
  return (
    <li>
      <Link href="/new" className="group grid rounded-lg ring-offset-4 ring-offset-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60">
        <span className="grid aspect-[5/7] w-full place-items-center rounded-[3px_7px_7px_3px] border-2 border-dashed border-foreground/15 text-muted-foreground transition-colors group-hover:border-foreground/30 group-hover:bg-accent/40 group-hover:text-foreground">
          <span className="grid justify-items-center gap-2.5 text-sm font-medium">
            <span className="grid size-10 place-items-center rounded-full bg-muted transition-colors group-hover:bg-brand group-hover:text-brand-foreground">
              <Plus className="size-5" aria-hidden />
            </span>
            New audiobook
          </span>
        </span>
      </Link>
    </li>
  );
}

function BookGrid({ projects, now, withNewTile }: { projects: ProjectSummary[]; now: number; withNewTile: boolean }) {
  return (
    <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {projects.map((p) => (
        <BookTile key={p.id} p={p} now={now} />
      ))}
      {withNewTile && <NewTile />}
    </ul>
  );
}

function BookList({ projects, now }: { projects: ProjectSummary[]; now: number }) {
  const router = useRouter();
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-card">
      {/* Desktop table */}
      <table className="hidden w-full text-sm md:table">
        <thead className="border-b text-left text-xs text-muted-foreground">
          <tr>
            <th className="w-[44%] px-5 py-3 font-medium">Book</th>
            <th className="px-3 py-3 font-medium">Status</th>
            <th className="px-3 py-3 text-right font-medium">Pages / words</th>
            <th className="px-3 py-3 text-right font-medium">Narration</th>
            <th className="px-3 py-3 text-right font-medium">Created</th>
            <th className="w-10" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr
              key={p.id}
              className="group cursor-pointer border-b transition-colors last:border-b-0 hover:bg-accent/50"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('a')) router.push(`/projects/${p.id}`);
              }}
            >
              <td className="max-w-0 px-5 py-3">
                <div className="flex items-center gap-3.5">
                  <BookCover projectId={p.id} title={p.name} size="xs" className="w-8" />
                  <div className="grid min-w-0 gap-0.5">
                    <Link href={`/projects/${p.id}`} className="truncate font-serif text-[15px] font-medium hover:underline focus-visible:underline focus-visible:outline-none" title={p.name}>
                      {p.name}
                    </Link>
                    <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" title={p.fileName}>
                      <FileText className="size-3 shrink-0" aria-hidden />
                      {p.fileName}
                    </p>
                  </div>
                </div>
              </td>
              <td className="px-3 py-3">
                <div className="flex flex-col gap-1.5">
                  <StatusBadge status={p.status} />
                  {isActive(p.status) && (
                    <div className="flex items-center gap-2">
                      <Progress value={p.progress} className="h-1 w-24" indicatorClassName="bg-info" />
                      <span className="text-xs text-muted-foreground tabular">{Math.round(p.progress)}%</span>
                    </div>
                  )}
                </div>
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap text-muted-foreground tabular">
                {formatNumber(p.pageCount)} <span className="text-muted-foreground/50">/</span> {formatNumber(p.wordCount)}
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap tabular">{p.durationSec ? formatDuration(p.durationSec) : <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-3 text-right whitespace-nowrap text-muted-foreground" title={formatDate(p.createdAt)}>
                {formatRelative(p.createdAt, now)}
              </td>
              <td className="pr-4 text-muted-foreground/60 group-hover:text-foreground">
                <ChevronRight className="size-4" aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile list */}
      <ul className="divide-y md:hidden">
        {projects.map((p) => (
          <li key={p.id}>
            <Link href={`/projects/${p.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors active:bg-muted/50">
              <BookCover projectId={p.id} title={p.name} size="xs" className="w-10" />
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="truncate font-serif text-[15px] font-medium">{p.name}</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge status={p.status} />
                  <span className="text-xs text-muted-foreground tabular">
                    {formatNumber(p.pageCount)} pages{p.durationSec ? ` · ${formatDuration(p.durationSec)}` : ''}
                  </span>
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────── page ───────────────────────────────

export function Dashboard() {
  const { projects, performance } = useAppState();
  const now = useNow();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useLibraryView();
  const search = useRef<HTMLInputElement>(null);

  // "/" focuses the search field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const list = projects.data;
  const all = list ?? [];
  const active = all.filter((p) => isActive(p.status));
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, (list ?? []).filter(f.match).length])) as Record<Filter, number>, [list]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.value === filter) ?? FILTERS[0];
    return (list ?? []).filter((p) => f.match(p) && (!q || p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q)));
  }, [list, filter, q]);
  const totalSec = all.reduce((n, p) => n + (p.status === 'COMPLETED' ? (p.durationSec ?? 0) : 0), 0);

  const description = !list?.length
    ? 'Your narrated read-along books.'
    : [`${all.length} ${all.length === 1 ? 'audiobook' : 'audiobooks'}`, totalSec > 0 ? `${formatDuration(totalSec)} narrated` : undefined, active.length ? `${active.length} processing` : undefined]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="grid gap-8">
      <PageHeader title="Library" description={description} />

      <HealthBanner />

      {projects.error && !list ? (
        <ApiErrorAlert error={projects.error} onRetry={() => void projects.refresh()} />
      ) : projects.loading && !list ? (
        <LibrarySkeleton />
      ) : list && list.length === 0 ? (
        <EmptyState />
      ) : list ? (
        <>
          {projects.error && <ApiErrorAlert error={projects.error} title="Could not refresh the library" />}

          {active.length > 0 && <NowProcessing projects={active} paused={!!performance.data?.prefs.paused} />}

          <section aria-label="Books" className="grid gap-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="-mx-4 overflow-x-auto px-4 scrollbar-thin md:mx-0 md:px-0">
                <Segmented value={filter} onValueChange={(v) => setFilter(v as Filter)} aria-label="Filter books" className="w-max sm:w-max">
                  {FILTERS.map((f) => (
                    <SegmentedItem key={f.value} value={f.value} className="px-3">
                      {f.label}
                      <span className="text-xs font-normal text-muted-foreground tabular">{counts[f.value]}</span>
                    </SegmentedItem>
                  ))}
                </Segmented>
              </div>
              <div className="flex items-center gap-2 md:ml-auto">
                <div className="relative flex-1 md:w-64 md:flex-none">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    ref={search}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())}
                    placeholder="Search books"
                    aria-label="Search books"
                    className="bg-card pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  ) : (
                    <Kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 text-muted-foreground md:inline-flex">/</Kbd>
                  )}
                </div>
                <Segmented value={view} onValueChange={(v) => setView(v as 'grid' | 'list')} aria-label="Layout" className="w-fit shrink-0">
                  <SegmentedItem value="grid" aria-label="Grid" title="Grid" className="px-2.5">
                    <LayoutGrid aria-hidden />
                  </SegmentedItem>
                  <SegmentedItem value="list" aria-label="List" title="List" className="px-2.5">
                    <List aria-hidden />
                  </SegmentedItem>
                </Segmented>
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="grid justify-items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
                <p className="text-sm text-muted-foreground">{q ? `No books match “${query.trim()}”.` : 'No books in this view.'}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Show all books
                </Button>
              </div>
            ) : view === 'grid' ? (
              <BookGrid projects={shown} now={now} withNewTile={filter === 'all' && !q} />
            ) : (
              <BookList projects={shown} now={now} />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}


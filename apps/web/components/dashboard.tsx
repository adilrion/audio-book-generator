'use client';

import type { ProjectSummary } from '@app/types';
import { BookAudio, ChevronRight, FileText, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { HealthBanner } from '@/components/health-banner';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { formatDate, formatDuration, formatNumber, formatRelative } from '@/lib/format';
import { isActive } from '@/lib/stages';

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ProjectProgress({ p }: { p: ProjectSummary }) {
  if (!isActive(p.status)) return null;
  return (
    <div className="flex items-center gap-2">
      <Progress value={p.progress} className="h-1.5 w-24" />
      <span className="text-xs text-muted-foreground tabular">{Math.round(p.progress)}%</span>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="items-center gap-4 border-dashed px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-xl bg-brand/25 text-brand-foreground dark:text-brand">
        <BookAudio className="size-6" aria-hidden />
      </span>
      <div className="grid gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight">No audiobooks yet</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Upload a PDF book and get a narrated, read-along video with the spoken sentence highlighted on the page.
        </p>
      </div>
      <Button asChild>
        <Link href="/new">
          <Plus aria-hidden /> New Audiobook
        </Link>
      </Button>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <Card className="gap-0 py-0">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b px-5 py-4 last:border-b-0">
          <Skeleton className="size-9 rounded-lg" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </Card>
  );
}

function ProjectTable({ projects, now }: { projects: ProjectSummary[]; now: number }) {
  const router = useRouter();
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* Desktop table */}
      <table className="hidden w-full text-sm md:table">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-5 py-2.5 font-medium">Project</th>
            <th className="px-3 py-2.5 font-medium">Status</th>
            <th className="px-3 py-2.5 text-right font-medium">Pages / words</th>
            <th className="px-3 py-2.5 text-right font-medium">Narration</th>
            <th className="px-3 py-2.5 text-right font-medium">Created</th>
            <th className="w-8" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr
              key={p.id}
              className="group cursor-pointer border-b transition-colors last:border-b-0 hover:bg-muted/40"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('a')) router.push(`/projects/${p.id}`);
              }}
            >
              <td className="max-w-0 px-5 py-3.5">
                <Link href={`/projects/${p.id}`} className="block truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none" title={p.name}>
                  {p.name}
                </Link>
                <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground" title={p.fileName}>
                  <FileText className="size-3 shrink-0" aria-hidden />
                  {p.fileName}
                </p>
              </td>
              <td className="px-3 py-3.5">
                <div className="flex flex-col gap-1.5">
                  <StatusBadge status={p.status} />
                  <ProjectProgress p={p} />
                </div>
              </td>
              <td className="px-3 py-3.5 text-right whitespace-nowrap text-muted-foreground tabular">
                {formatNumber(p.pageCount)} <span className="text-muted-foreground/60">/</span> {formatNumber(p.wordCount)}
              </td>
              <td className="px-3 py-3.5 text-right whitespace-nowrap tabular">{p.durationSec ? formatDuration(p.durationSec) : <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-3.5 text-right whitespace-nowrap text-muted-foreground" title={formatDate(p.createdAt)}>
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
            <Link href={`/projects/${p.id}`} className="flex items-start gap-3 px-4 py-3.5 transition-colors active:bg-muted/50">
              <div className="grid min-w-0 flex-1 gap-1.5">
                <p className="truncate font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">{p.fileName}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <StatusBadge status={p.status} />
                  <ProjectProgress p={p} />
                </div>
                <p className="text-xs text-muted-foreground tabular">
                  {formatNumber(p.pageCount)} pages · {formatNumber(p.wordCount)} words{p.durationSec ? ` · ${formatDuration(p.durationSec)}` : ''} · {formatRelative(p.createdAt, now)}
                </p>
              </div>
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Dashboard() {
  const [pollMs, setPollMs] = useState(15_000);
  const projects = useApi('projects', (signal) => api.listProjects(signal), { interval: pollMs });
  const now = useNow();

  // Poll fast while something is processing, slower while something is queued/not started.
  useEffect(() => {
    const list = projects.data ?? [];
    setPollMs(list.some((p) => isActive(p.status)) ? 2000 : list.some((p) => p.status === 'PENDING') ? 5000 : 15_000);
  }, [projects.data]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Turn PDF books into narrated read-along videos — locally on your Mac.</p>
        </div>
        <Button asChild>
          <Link href="/new">
            <Plus aria-hidden /> New Audiobook
          </Link>
        </Button>
      </div>

      <HealthBanner />

      {projects.error && !projects.data ? (
        <ApiErrorAlert error={projects.error} onRetry={() => void projects.refresh()} />
      ) : projects.loading && !projects.data ? (
        <ListSkeleton />
      ) : projects.data && projects.data.length === 0 ? (
        <EmptyState />
      ) : projects.data ? (
        <>
          {projects.error && <ApiErrorAlert error={projects.error} title="Could not refresh the project list" />}
          <ProjectTable projects={projects.data} now={now} />
        </>
      ) : null}
    </div>
  );
}

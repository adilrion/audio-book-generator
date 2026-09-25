import type { ProjectDetail } from '@app/types';
import { formatClock, formatDuration } from '@/lib/format';

/** Detected chapters with page ranges and narration durations. */
export function ChaptersList({ chapters, emptyText }: { chapters: ProjectDetail['chapters']; emptyText: string }) {
  if (!chapters.length) return <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">{emptyText}</p>;
  let t = 0;
  const total = chapters.reduce((n, c) => n + (c.durationSec ?? 0), 0);
  return (
    <>
      <ol className="divide-y">
        {chapters.map((c) => {
          const start = t;
          t += c.durationSec ?? 0;
          return (
            <li key={c.index} className="flex items-baseline gap-3 px-4 py-2.5 text-sm sm:px-5">
              <span className="w-5 shrink-0 text-xs text-muted-foreground tabular">{c.index + 1}</span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate" title={c.title}>
                  {c.title}
                </span>
                <span className="text-xs text-muted-foreground tabular">
                  {c.pageStart === c.pageEnd ? `Page ${c.pageStart}` : `Pages ${c.pageStart}–${c.pageEnd}`}
                  {c.durationSec !== undefined && ` · starts at ${formatClock(start)}`}
                </span>
              </div>
              <span className="shrink-0 text-xs tabular">{c.durationSec !== undefined ? formatDuration(c.durationSec) : <span className="text-muted-foreground">—</span>}</span>
            </li>
          );
        })}
      </ol>
      {total > 0 && (
        <p className="flex justify-between border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
          <span>
            {chapters.length} chapter{chapters.length === 1 ? '' : 's'}
          </span>
          <span className="tabular">{formatDuration(total)} narrated</span>
        </p>
      )}
    </>
  );
}

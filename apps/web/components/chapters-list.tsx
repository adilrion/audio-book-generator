import type { ProjectDetail } from '@app/types';
import { formatClock, formatDuration } from '@/lib/format';

/** Detected chapters with page ranges and narration durations. */
export function ChaptersList({ chapters, emptyText }: { chapters: ProjectDetail['chapters']; emptyText: string }) {
  if (!chapters.length) return <p className="px-5 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>;
  let t = 0;
  const total = chapters.reduce((n, c) => n + (c.durationSec ?? 0), 0);
  return (
    <>
      <ol className="grid max-h-[26rem] gap-0.5 overflow-y-auto p-2 scrollbar-thin">
        {chapters.map((c) => {
          const start = t;
          t += c.durationSec ?? 0;
          return (
            <li key={c.index} className="flex items-baseline gap-3 rounded-lg px-3 py-2 text-sm">
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular">{c.index + 1}</span>
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
        <p className="flex justify-between border-t px-5 py-3 text-xs text-muted-foreground">
          <span>
            {chapters.length} chapter{chapters.length === 1 ? '' : 's'}
          </span>
          <span className="tabular">{formatDuration(total)} narrated</span>
        </p>
      )}
    </>
  );
}

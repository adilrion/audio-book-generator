'use client';

import type { OutputFile } from '@app/types';
import { Captions, Check, Copy, Download, Film, ListVideo, Music, PackageOpen } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/hooks/use-copy';
import { apiUrl } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

const META: Record<string, { label: string; description: string; icon: typeof Film; tint: string }> = {
  'audiobook.mp4': { label: 'Read-along video', description: 'H.264 + AAC MP4, ready for YouTube', icon: Film, tint: 'bg-brand/25 text-brand-foreground dark:bg-brand/15 dark:text-brand' },
  'audiobook.m4a': { label: 'Audiobook', description: 'AAC audio with chapter markers', icon: Music, tint: 'bg-info/12 text-info' },
  'subtitles.srt': { label: 'Subtitles', description: 'SRT captions, one cue per sentence', icon: Captions, tint: 'bg-success/12 text-success' },
  'chapters.txt': { label: 'YouTube chapters', description: 'Timestamps to paste into the video description', icon: ListVideo, tint: 'bg-muted text-muted-foreground' },
};

const ORDER = ['audiobook.mp4', 'audiobook.m4a', 'subtitles.srt', 'chapters.txt'];

function CopyChapters({ url }: { url: string }) {
  const { copied, copy } = useCopy();
  const [failed, setFailed] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? 'Copied' : 'Copy YouTube chapters'}
      title={failed ? 'Could not read chapters.txt' : copied ? 'Copied' : 'Copy chapter timestamps'}
      onClick={async () => {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) throw new Error();
          setFailed(!(await copy(await res.text())));
        } catch {
          setFailed(true);
        }
      }}
    >
      {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

/** Export section: final files with sizes and download links. */
export function OutputsList({ outputs, pending }: { outputs: OutputFile[]; pending?: boolean }) {
  const files = [...outputs].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
  if (!files.length)
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-sm text-muted-foreground">
        <span className="grid size-10 place-items-center rounded-xl bg-muted">
          <PackageOpen className="size-5" aria-hidden />
        </span>
        {pending ? 'Files appear here as soon as they are ready.' : 'No output files yet — start processing to create them.'}
      </div>
    );
  return (
    <ul className="grid gap-1 p-2">
      {files.map((f) => {
        const meta = META[f.name] ?? { label: f.name, description: f.kind, icon: PackageOpen, tint: 'bg-muted text-muted-foreground' };
        const Icon = meta.icon;
        return (
          <li key={f.name} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
            <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', meta.tint)}>
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5" title={meta.description}>
              <p className="truncate text-sm font-medium">{meta.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{f.name}</span> · <span className="tabular">{formatBytes(f.size)}</span>
              </p>
            </div>
            {f.name === 'chapters.txt' && <CopyChapters url={`${apiUrl(f.url)}?inline=1`} />}
            <Button asChild variant="outline" size="icon-sm">
              <a href={apiUrl(f.url)} download={f.name} aria-label={`Download ${f.name}`} title={`Download ${f.name}`}>
                <Download aria-hidden />
              </a>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

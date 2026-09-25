'use client';

import type { OutputFile } from '@app/types';
import { Captions, Check, Copy, Download, Film, ListVideo, Music, PackageOpen } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/hooks/use-copy';
import { apiUrl } from '@/lib/api';
import { formatBytes } from '@/lib/format';

const META: Record<string, { label: string; description: string; icon: typeof Film }> = {
  'audiobook.mp4': { label: 'Read-along video', description: 'H.264 + AAC MP4, ready for YouTube', icon: Film },
  'audiobook.m4a': { label: 'Audiobook', description: 'AAC audio with chapter markers', icon: Music },
  'subtitles.srt': { label: 'Subtitles', description: 'SRT captions, one cue per sentence', icon: Captions },
  'chapters.txt': { label: 'YouTube chapters', description: 'Timestamps to paste into the video description', icon: ListVideo },
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
        <PackageOpen className="size-6" aria-hidden />
        {pending ? 'Files appear here as soon as they are ready.' : 'No output files yet — start processing to create them.'}
      </div>
    );
  return (
    <ul className="divide-y">
      {files.map((f) => {
        const meta = META[f.name] ?? { label: f.name, description: f.kind, icon: PackageOpen };
        const Icon = meta.icon;
        return (
          <li key={f.name} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <p className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-mono text-[13px] font-medium">{f.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular">{formatBytes(f.size)}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {meta.label} — {meta.description}
              </p>
            </div>
            {f.name === 'chapters.txt' && <CopyChapters url={`${apiUrl(f.url)}?inline=1`} />}
            <Button asChild variant="outline" size="sm">
              <a href={apiUrl(f.url)} download={f.name}>
                <Download aria-hidden /> <span className="hidden sm:inline">Download</span>
              </a>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

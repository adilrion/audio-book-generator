'use client';

import { useEffect, useState } from 'react';
import { pageImageUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

function hueOf(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/**
 * A book cover: the PDF's first page (rendered on demand by the API and cached), with a
 * generated typographic cover while there is no page image (no project yet, or rendering failed).
 * Set the size with `className` (e.g. `w-24`); the aspect ratio is a trade paperback's.
 */
export function BookCover({ projectId, title, className, size = 'md' }: { projectId?: string; title: string; className?: string; size?: 'xs' | 'md' }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(projectId ? 'loading' : 'failed');
  useEffect(() => setState(projectId ? 'loading' : 'failed'), [projectId]);
  const hue = hueOf(projectId ?? title);
  const generated = state === 'failed';
  const xs = size === 'xs';

  return (
    <div
      className={cn(
        '@container relative isolate aspect-[5/7] shrink-0 overflow-hidden bg-[oklch(0.955_0.006_84)] shadow-book dark:bg-[oklch(0.3_0.008_62)]',
        xs ? 'rounded-[3px]' : 'rounded-[3px_7px_7px_3px]',
        state === 'loading' && 'animate-pulse',
        className,
      )}
      style={generated ? { background: `linear-gradient(155deg, oklch(0.6 0.1 ${hue}), oklch(0.34 0.08 ${(hue + 40) % 360}))` } : undefined}
    >
      {generated && (
        <div className="absolute inset-0 flex flex-col justify-between p-[12%] text-white" aria-hidden>
          {xs ? (
            <span className="m-auto font-serif text-[60cqw] leading-none font-semibold">{title.trim().charAt(0).toUpperCase() || '·'}</span>
          ) : (
            <>
              <span className="mt-[30%] grid gap-[7cqw]">
                <span className="h-px w-1/3 bg-white/55" />
                <span className="line-clamp-5 font-serif text-[11cqw] leading-[1.08] font-medium tracking-tight text-balance">{title}</span>
              </span>
              <span className="text-[6.5cqw] font-medium tracking-[0.2em] text-white/70 uppercase">Audiobook</span>
            </>
          )}
        </div>
      )}
      {projectId && !generated && (
        // eslint-disable-next-line @next/next/no-img-element -- page renders come from the local API
        <img
          src={pageImageUrl(projectId, 1)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0) setState((s) => (s === 'loading' ? 'loaded' : s));
          }}
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
          className={cn('absolute inset-0 size-full object-cover object-top transition-opacity duration-500 select-none', state === 'loaded' ? 'opacity-100' : 'opacity-0')}
        />
      )}
      {/* spine shading + edge so white pages don't melt into a white card */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-[7%] bg-linear-to-r from-black/20 via-white/10 to-transparent" aria-hidden />
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-black/10 ring-inset dark:ring-white/10" aria-hidden />
    </div>
  );
}

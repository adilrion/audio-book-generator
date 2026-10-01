'use client';

import {
  type PublishContext,
  type PublishDraft,
  type SocialPlatform,
  SOCIAL_RULES,
  YOUTUBE_LIMITS,
  chaptersProblem,
  composeDescription,
  composeSocial,
  socialLength,
} from '@app/types';
import { Globe, ImageIcon, Lock, Link2, ThumbsUp, MessageCircle, Share2, Eye } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { formatClock } from '@/lib/format';
import { VISIBILITY_LABELS } from '@/lib/publish';
import { cn } from '@/lib/utils';

/** Timestamps, #hashtags and links styled the way YouTube renders them. */
function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('break-words', className)}>
      {text.split('\n').map((line, li) => {
        const ts = /^((?:\d{1,2}:)?\d{1,2}:\d{2})(\s)/.exec(line);
        const rest = ts ? line.slice(ts[0].length) : line;
        return (
          <span key={li}>
            {li > 0 && <br />}
            {ts && <span className="text-info">{ts[1]}</span>}
            {ts?.[2]}
            {rest.split(/(#[\p{L}\p{M}\p{N}_]+|https?:\/\/\S+)/u).map((p, i) =>
              i % 2 ? (
                <span key={i} className="text-info">
                  {p}
                </span>
              ) : (
                p
              ),
            )}
          </span>
        );
      })}
    </span>
  );
}

function Thumb({ src, durationSec, className }: { src?: string; durationSec: number; className?: string }) {
  return (
    <div className={cn('relative aspect-video overflow-hidden rounded-xl bg-muted', className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- local preview (data URL or the API)
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center text-muted-foreground">
          <ImageIcon className="size-6" aria-hidden />
        </span>
      )}
      <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1 py-px text-[11px] font-medium text-white tabular">{formatClock(durationSec)}</span>
    </div>
  );
}

function Avatar({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-full bg-brand text-sm font-semibold text-brand-foreground', className)} aria-hidden>
      {label.trim().charAt(0).toUpperCase() || 'Y'}
    </span>
  );
}

/** The watch page: hashtags above the title, channel row, collapsed description box. */
export function WatchPreview({ draft, ctx, thumb }: { draft: PublishDraft; ctx: PublishContext; thumb?: string }) {
  const [open, setOpen] = useState(false);
  const yt = draft.youtube;
  const desc = composeDescription(yt, ctx.chapters);
  const top = yt.hashtags.slice(0, 3);
  const VisIcon = yt.visibility === 'public' ? Globe : yt.visibility === 'unlisted' ? Link2 : Lock;
  return (
    <div className="grid gap-3">
      <Thumb src={thumb} durationSec={ctx.durationSec} />
      <div className="grid gap-1">
        {top.length > 0 && <p className="truncate text-xs text-info">{top.map((h) => `#${h}`).join(' ')}</p>}
        <h3 className="line-clamp-2 text-[17px] leading-snug font-semibold break-words">{yt.title || <span className="text-muted-foreground">Untitled video</span>}</h3>
      </div>
      <div className="flex items-center gap-2.5">
        <Avatar label={ctx.author ?? ctx.title} />
        <div className="grid min-w-0 flex-1">
          <span className="truncate text-sm font-medium">Your channel</span>
          <span className="text-xs text-muted-foreground">0 subscribers</span>
        </div>
        <span className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background">Subscribe</span>
      </div>
      <div className="flex gap-2 text-xs text-muted-foreground">
        {[ThumbsUp, Share2].map((I, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1">
            <I className="size-3.5" aria-hidden /> {i === 0 ? 'Like' : 'Share'}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1" title="Visibility">
          <VisIcon className="size-3.5" aria-hidden /> {VISIBILITY_LABELS[yt.visibility]}
        </span>
      </div>
      <div className="rounded-xl bg-muted p-3 text-[13px] leading-relaxed">
        <p className="mb-1 font-medium">0 views · just now</p>
        <div className={cn(!open && 'line-clamp-3')}>
          <RichText text={desc || 'No description yet.'} />
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 font-medium hover:underline">
          {open ? 'Show less' : '…more'}
        </button>
      </div>
      {yt.pinnedComment.trim() && (
        <div className="flex gap-2.5 text-[13px]">
          <Avatar label={ctx.author ?? ctx.title} className="size-7 text-xs" />
          <div className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">📌 Pinned by you</span>
            <p className="break-words">{yt.pinnedComment}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** A search result row: what decides the click — thumbnail, title, the first line of the description. */
export function SearchPreview({ draft, ctx, thumb }: { draft: PublishDraft; ctx: PublishContext; thumb?: string }) {
  const yt = draft.youtube;
  const snippet = [...yt.description.replace(/\s+/g, ' ').trim()].slice(0, YOUTUBE_LIMITS.descriptionSnippet).join('');
  const chapters = yt.includeChapters && !chaptersProblem(ctx.chapters) ? ctx.chapters.length : 0;
  const title = [...yt.title].length > YOUTUBE_LIMITS.titleVisible ? `${[...yt.title].slice(0, YOUTUBE_LIMITS.titleVisible - 1).join('').trimEnd()}…` : yt.title;
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-[44%_minmax(0,1fr)] gap-3">
        <Thumb src={thumb} durationSec={ctx.durationSec} className="rounded-lg" />
        <div className="grid content-start gap-1">
          <h3 className="line-clamp-2 text-sm leading-snug font-medium break-words">{title || 'Untitled video'}</h3>
          <p className="text-[11px] text-muted-foreground">0 views · just now</p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Avatar label={ctx.author ?? ctx.title} className="size-4 text-[8px]" /> Your channel
          </p>
          <p className="line-clamp-2 text-[11px] text-muted-foreground">{snippet}</p>
          {chapters > 0 && <span className="mt-0.5 w-fit rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{chapters} chapters</span>}
        </div>
      </div>
      <div className="grid gap-2 border-t pt-4">
        <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">On a phone</p>
        <div className="mx-auto grid w-full max-w-[300px] gap-2">
          <Thumb src={thumb} durationSec={ctx.durationSec} className="rounded-none" />
          <div className="flex gap-2.5">
            <Avatar label={ctx.author ?? ctx.title} className="size-8 text-xs" />
            <div className="grid min-w-0 gap-0.5">
              <h3 className="line-clamp-2 text-[13px] leading-snug font-medium break-words">{yt.title || 'Untitled video'}</h3>
              <p className="text-[11px] text-muted-foreground">Your channel · 0 views · just now</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A generic social post with the link card the platform unfurls. */
export function SocialPreview({ platform, draft, ctx, thumb }: { platform: SocialPlatform; draft: PublishDraft; ctx: PublishContext; thumb?: string }) {
  const [open, setOpen] = useState(false);
  const post = draft.social[platform];
  const rule = SOCIAL_RULES[platform];
  const text = composeSocial(post, platform === 'instagram' ? undefined : draft.videoUrl);
  const len = socialLength(platform, post, draft.videoUrl);
  const cut = platform === 'instagram' ? 125 : platform === 'linkedin' ? 210 : undefined;
  const long = cut !== undefined && [...text].length > cut;
  const shown = long && !open ? `${[...text].slice(0, cut).join('').trimEnd()}… ` : text;
  const square = platform === 'instagram' || platform === 'tiktok';
  const media: ReactNode = (
    <div className={cn('relative overflow-hidden bg-muted', square ? 'aspect-square' : 'aspect-video rounded-t-lg')}>
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element -- local preview
        <img src={thumb} alt="" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center text-muted-foreground">
          <ImageIcon className="size-6" aria-hidden />
        </span>
      )}
    </div>
  );
  return (
    <div className="grid gap-3">
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2.5 p-3">
          <Avatar label={ctx.author ?? ctx.title} className="size-8 text-xs" />
          <div className="grid min-w-0">
            <span className="truncate text-[13px] font-medium">Your account</span>
            <span className="text-[11px] text-muted-foreground">{rule.label} · just now</span>
          </div>
        </div>
        {square && media}
        <div className="px-3 pt-1 pb-3 text-[13px] leading-relaxed">
          <RichText text={shown} />
          {long && (
            <button type="button" className="font-medium text-muted-foreground hover:underline" onClick={() => setOpen((o) => !o)}>
              {open ? ' less' : 'more'}
            </button>
          )}
        </div>
        {!square && (
          <div className="mx-3 mb-3 overflow-hidden rounded-lg border">
            {media}
            <div className="grid gap-0.5 p-2.5">
              <span className="text-[10px] tracking-wide text-muted-foreground uppercase">youtube.com</span>
              <span className="line-clamp-2 text-[13px] font-medium">{draft.youtube.title}</span>
            </div>
          </div>
        )}
        <div className="flex gap-5 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ThumbsUp className="size-3.5" aria-hidden /> Like
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="size-3.5" aria-hidden /> Comment
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3.5" aria-hidden /> {len.toLocaleString()}/{rule.max.toLocaleString()}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{rule.note}</p>
    </div>
  );
}

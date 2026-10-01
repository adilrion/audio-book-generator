'use client';

import { type PublishContext, type PublishDraft, SOCIAL_PLATFORMS, SOCIAL_RULES, seoReport } from '@app/types';
import { ArrowRight, Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type DiffPart, diffWords } from '@/lib/diff';
import { categoryLabel, cloneDraft } from '@/lib/publish';
import { cn } from '@/lib/utils';

type Value = string | string[];

interface Field {
  key: string;
  group: 'YouTube' | 'Thumbnail & file' | 'Social posts';
  label: string;
  section: 'youtube' | 'social' | 'other';
  list?: boolean;
  /** Shown with a leading "#". */
  hash?: boolean;
  get: (d: PublishDraft) => Value;
  set: (d: PublishDraft, v: Value) => void;
  /** Display form (e.g. category id → name). */
  show?: (v: string) => string;
}

const text = (v: Value) => (Array.isArray(v) ? v.join(', ') : v);

const FIELDS: Field[] = [
  { key: 'title', group: 'YouTube', section: 'youtube', label: 'Title', get: (d) => d.youtube.title, set: (d, v) => void (d.youtube.title = text(v)) },
  { key: 'keyword', group: 'YouTube', section: 'youtube', label: 'Main search phrase', get: (d) => d.youtube.primaryKeyword, set: (d, v) => void (d.youtube.primaryKeyword = text(v)) },
  { key: 'description', group: 'YouTube', section: 'youtube', label: 'Description', get: (d) => d.youtube.description, set: (d, v) => void (d.youtube.description = text(v)) },
  { key: 'tags', group: 'YouTube', section: 'youtube', label: 'Tags', list: true, get: (d) => d.youtube.tags, set: (d, v) => void (d.youtube.tags = v as string[]) },
  { key: 'hashtags', group: 'YouTube', section: 'youtube', label: 'Hashtags', list: true, hash: true, get: (d) => d.youtube.hashtags, set: (d, v) => void (d.youtube.hashtags = v as string[]) },
  { key: 'pinned', group: 'YouTube', section: 'youtube', label: 'Pinned comment', get: (d) => d.youtube.pinnedComment, set: (d, v) => void (d.youtube.pinnedComment = text(v)) },
  { key: 'category', group: 'YouTube', section: 'youtube', label: 'Category', get: (d) => d.youtube.categoryId, set: (d, v) => void (d.youtube.categoryId = text(v)), show: categoryLabel },
  { key: 'thumbText', group: 'Thumbnail & file', section: 'youtube', label: 'Thumbnail text', get: (d) => d.youtube.thumbnailText, set: (d, v) => void (d.youtube.thumbnailText = text(v)) },
  {
    key: 'kicker',
    group: 'Thumbnail & file',
    section: 'other',
    label: 'Thumbnail small line',
    get: (d) => d.thumbnail?.kicker ?? '',
    set: (d, v) => void (d.thumbnail = d.thumbnail ? { ...d.thumbnail, kicker: text(v) } : d.thumbnail),
  },
  { key: 'fileTitle', group: 'Thumbnail & file', section: 'other', label: 'File title', get: (d) => d.file.title, set: (d, v) => void (d.file.title = text(v)) },
  { key: 'fileComment', group: 'Thumbnail & file', section: 'other', label: 'File comment', get: (d) => d.file.comment, set: (d, v) => void (d.file.comment = text(v)) },
  ...SOCIAL_PLATFORMS.flatMap((p): Field[] => [
    { key: `${p}.text`, group: 'Social posts', section: 'social', label: `${SOCIAL_RULES[p].label} post`, get: (d) => d.social[p].text, set: (d, v) => void (d.social[p] = { ...d.social[p], text: text(v) }) },
    {
      key: `${p}.hashtags`,
      group: 'Social posts',
      section: 'social',
      label: `${SOCIAL_RULES[p].label} hashtags`,
      list: true,
      hash: true,
      get: (d) => d.social[p].hashtags,
      set: (d, v) => void (d.social[p] = { ...d.social[p], hashtags: v as string[] }),
    },
  ]),
];

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

function Diff({ parts, side }: { parts: DiffPart[]; side: 'left' | 'right' }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts
        .filter((p) => p.type === 'same' || p.type === (side === 'left' ? 'removed' : 'added'))
        .map((p, i) =>
          p.type === 'same' ? (
            <span key={i}>{p.text}</span>
          ) : (
            <mark
              key={i}
              className={cn('rounded-[3px] px-px', side === 'left' ? 'bg-destructive/15 text-foreground line-through decoration-destructive/60' : 'bg-success/20 text-foreground')}
            >
              {p.text}
            </mark>
          ),
        )}
    </span>
  );
}

function Chips({ items, other, side, hash }: { items: string[]; other: string[]; side: 'left' | 'right'; hash?: boolean }) {
  const o = new Set(other.map((x) => x.toLocaleLowerCase()));
  if (!items.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((t) => {
        const unique = !o.has(t.toLocaleLowerCase());
        return (
          <span
            key={t}
            className={cn(
              'rounded-md px-1.5 py-0.5 text-xs',
              unique ? (side === 'left' ? 'bg-destructive/15 line-through decoration-destructive/60' : 'bg-success/20') : 'bg-muted text-muted-foreground',
            )}
          >
            {hash ? '#' : ''}
            {t}
          </span>
        );
      })}
    </span>
  );
}

export interface CompareSide {
  label: string;
  draft: PublishDraft;
}

/**
 * Side-by-side review of two drafts — the current one and an AI suggestion (or an earlier version).
 * Only fields that differ are listed; click a side to keep it. Changed words are highlighted, and the
 * SEO score is shown for both sides and for the selection.
 */
export function PublishCompare({
  open,
  onOpenChange,
  title,
  description,
  left,
  right,
  ctx,
  seo,
  defaultSide,
  applyLabel,
  busy,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  left: CompareSide;
  right: CompareSide;
  ctx: PublishContext;
  seo: { thumbnail: boolean; applied: 'current' | 'stale' | 'none' };
  /** Which side each changed field starts on. */
  defaultSide: 'left' | 'right';
  applyLabel: string;
  busy?: boolean;
  onApply: (merged: PublishDraft, picked: { right: number; total: number }) => void;
}) {
  const changed = useMemo(() => FIELDS.filter((f) => !same(f.get(left.draft), f.get(right.draft))), [left.draft, right.draft]);
  const [pick, setPick] = useState<Record<string, 'left' | 'right'>>({});
  useEffect(() => {
    if (open) setPick(Object.fromEntries(changed.map((f) => [f.key, defaultSide])));
  }, [open, changed, defaultSide]);

  const merged = useMemo(() => {
    const d = cloneDraft(left.draft);
    let yt = false;
    let social = false;
    for (const f of changed) {
      if (pick[f.key] !== 'right') continue;
      const v = f.get(right.draft);
      f.set(d, Array.isArray(v) ? [...v] : v);
      if (f.section === 'youtube') yt = true;
      if (f.section === 'social') social = true;
    }
    // Keep the suggestion's title ideas and say where the words came from.
    if (yt) {
      d.youtube.titleOptions = [...new Set([...right.draft.youtube.titleOptions, ...left.draft.youtube.titleOptions])].slice(0, 6);
      d.origin = { ...d.origin, youtube: right.draft.origin.youtube };
    }
    if (social) d.origin = { ...d.origin, social: right.draft.origin.social };
    if (yt || social) {
      d.model = right.draft.model ?? d.model;
      d.generatedAt = right.draft.generatedAt ?? d.generatedAt;
    }
    return d;
  }, [left.draft, right.draft, changed, pick]);

  const scores = useMemo(
    () => ({ left: seoReport(left.draft, ctx, seo).score, right: seoReport(right.draft, ctx, seo).score, merged: seoReport(merged, ctx, seo).score }),
    [left.draft, right.draft, merged, ctx, seo],
  );
  const rightCount = changed.filter((f) => pick[f.key] === 'right').length;
  const groups = [...new Set(changed.map((f) => f.group))];

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="gap-3 border-b p-5 pr-12 sm:p-6 sm:pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="text-muted-foreground">SEO score</span>
            <span className="tabular">
              {left.label} <b>{scores.left}</b>
            </span>
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="tabular">
              {right.label} <b className={cn(scores.right > scores.left ? 'text-success' : scores.right < scores.left && 'text-destructive')}>{scores.right}</b>
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 tabular">
              Your pick <b>{scores.merged}</b>
            </span>
            <span className="ml-auto flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setPick(Object.fromEntries(changed.map((f) => [f.key, 'left'])))} disabled={!changed.length}>
                Keep all · {left.label}
              </Button>
              <Button size="xs" variant="outline" onClick={() => setPick(Object.fromEntries(changed.map((f) => [f.key, 'right'])))} disabled={!changed.length}>
                Use all · {right.label}
              </Button>
            </span>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto px-5 sm:px-6">
          {!changed.length ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Both versions are the same.</p>
          ) : (
            groups.map((g) => (
              <div key={g} className="grid">
                <p className="sticky top-0 z-10 bg-popover pt-5 pb-2 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">{g}</p>
                {changed
                  .filter((f) => f.group === g)
                  .map((f) => {
                    const a = f.get(left.draft);
                    const b = f.get(right.draft);
                    const parts = f.list ? [] : diffWords(f.show ? f.show(text(a)) : text(a), f.show ? f.show(text(b)) : text(b));
                    return (
                      <div key={f.key} className="grid gap-2 border-b py-3 last:border-0" role="radiogroup" aria-label={f.label}>
                        <p className="text-[13px] font-medium">{f.label}</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {(['left', 'right'] as const).map((side) => {
                            const on = pick[f.key] === side;
                            return (
                              <button
                                key={side}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                onClick={() => setPick((p) => ({ ...p, [f.key]: side }))}
                                className={cn(
                                  'relative grid content-start gap-1.5 rounded-xl border p-3 pr-9 text-left text-[13px] leading-relaxed transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                                  on ? 'border-foreground/40 bg-accent/40 ring-1 ring-foreground/20' : 'opacity-75',
                                )}
                              >
                                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{side === 'left' ? left.label : right.label}</span>
                                <span className={cn(f.key === 'description' && 'max-h-72 overflow-y-auto')}>
                                  {f.list ? (
                                    <Chips items={side === 'left' ? (a as string[]) : (b as string[])} other={side === 'left' ? (b as string[]) : (a as string[])} side={side} hash={f.hash} />
                                  ) : text(side === 'left' ? a : b) ? (
                                    <Diff parts={parts} side={side} />
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </span>
                                {on && (
                                  <span className="absolute top-3 right-3 grid size-4 place-items-center rounded-full bg-foreground text-background" aria-hidden>
                                    <Check className="size-2.5" strokeWidth={3} />
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))
          )}
        </div>

        <DialogFooter className="items-center border-t p-4 sm:px-6">
          <span className="mr-auto text-xs text-muted-foreground">
            {changed.length ? `${rightCount} of ${changed.length} changes from “${right.label}”` : ''}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => onApply(merged, { right: rightCount, total: changed.length })} disabled={busy || !changed.length}>
            {applyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

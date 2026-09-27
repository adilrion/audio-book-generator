'use client';

import type { ProjectDetail, TextRepair } from '@app/types';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { diffText } from '@/lib/diff';

const FIRST = 5;

/** Spaces are most of what repairs change ("T h e" → "The"): draw them as ␣ so they can be seen. */
const visible = (text: string) => text.replace(/ /g, '\u2423');

function Diff({ repair }: { repair: TextRepair }) {
  return (
    <p className="font-serif text-[15px] leading-relaxed text-pretty break-words">
      {diffText(repair.before, repair.after).map((part, i) =>
        part.type === 'same' ? (
          <span key={i}>{part.text}</span>
        ) : part.type === 'removed' ? (
          <del key={i} className="rounded-[2px] bg-destructive/15 text-destructive decoration-destructive/70" title="Removed">
            {visible(part.text)}
          </del>
        ) : (
          <ins key={i} className="rounded-[2px] bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-400" title="Added">
            {visible(part.text)}
          </ins>
        ),
      )}
    </p>
  );
}

/**
 * What the local AI repaired: each sentence as a character diff of what the voice would have read
 * → what it reads now. Shown once the analysis is done; nothing when no sentence needed a repair.
 */
export function TextRepairs({ project }: { project: ProjectDetail }) {
  const analyzed = !!project.analysisKey && project.steps.some((s) => s.key === 'ANALYZE' && s.status === 'COMPLETED');
  const repairs = useApi(analyzed ? `repairs:${project.id}:${project.analysisKey}` : null, (signal) => api.repairs(project.id, signal));
  const [all, setAll] = useState(false);
  const list = repairs.data ?? [];
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, FIRST);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden /> Text repairs
        </CardTitle>
        <CardDescription>
          The local AI fixed PDF extraction damage — letter-spaced or glued words, broken characters — in {list.length.toLocaleString('en-US')}{' '}
          {list.length === 1 ? 'sentence' : 'sentences'}. Only what the voice reads changes; the page, highlight and subtitles keep the printed text. Changes that
          would reword a sentence are refused automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <del className="rounded-[2px] bg-destructive/15 px-1 text-destructive">removed</del>
          </span>
          <span className="flex items-center gap-1.5">
            <ins className="rounded-[2px] bg-emerald-500/15 px-1 text-emerald-700 no-underline dark:text-emerald-400">added</ins>
          </span>
        </div>
        <ol className="divide-y overflow-hidden rounded-xl border">
          {shown.map((r) => (
            <li key={r.sentenceId} className="grid gap-1.5 px-4 py-3">
              <p className="truncate text-xs text-muted-foreground tabular">
                {r.chapterTitle || `Chapter ${r.chapterIndex + 1}`} · page {r.page}
              </p>
              <Diff repair={r} />
            </li>
          ))}
        </ol>
        {list.length > FIRST && (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${list.length.toLocaleString('en-US')}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

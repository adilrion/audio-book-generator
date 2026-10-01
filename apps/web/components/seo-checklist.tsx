'use client';

import type { SeoCheck, SeoReport } from '@app/types';
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import { cn } from '@/lib/utils';

const ORDER = { fail: 0, warn: 1, pass: 2 } as const;

function Ring({ score }: { score: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const tone = score >= 80 ? 'text-success' : score >= 55 ? 'text-warning' : 'text-destructive';
  return (
    <div className="relative grid size-16 shrink-0 place-items-center">
      <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-foreground/10" />
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round" className={cn('stroke-current transition-[stroke-dashoffset] duration-500', tone)} strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} />
      </svg>
      <span className="text-lg font-semibold tabular">{score}</span>
    </div>
  );
}

/** Score + checklist; clicking an item jumps to the field that fixes it. */
export function SeoChecklist({ report, onJump }: { report: SeoReport; onJump: (c: SeoCheck) => void }) {
  const checks = [...report.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.weight - a.weight);
  const todo = checks.filter((c) => c.status !== 'pass').length;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-4">
        <Ring score={report.score} />
        <div className="grid gap-0.5">
          <p className="text-sm font-medium">{report.blocking ? `${report.blocking} problem${report.blocking > 1 ? 's' : ''} to fix before upload` : todo ? `${todo} suggestion${todo > 1 ? 's' : ''}` : 'Ready to upload'}</p>
          <p className="text-xs text-muted-foreground">YouTube rules and search best practice for title, description, tags and thumbnail.</p>
        </div>
      </div>
      <ul className="grid gap-0.5" aria-label="Checks">
        {checks.map((c) => {
          const Icon = c.status === 'pass' ? CircleCheck : c.status === 'warn' ? CircleAlert : CircleX;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onJump(c)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', c.status === 'pass' ? 'text-success' : c.status === 'warn' ? 'text-warning-foreground dark:text-warning' : 'text-destructive')}
                  aria-label={c.status === 'pass' ? 'Passed' : c.status === 'warn' ? 'Suggestion' : 'Problem'}
                />
                <span className="grid min-w-0 gap-0.5">
                  <span className={cn('text-[13px] leading-snug', c.status === 'pass' ? 'text-muted-foreground' : 'font-medium')}>{c.label}</span>
                  {c.status !== 'pass' && <span className="text-xs leading-snug text-muted-foreground">{c.detail}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

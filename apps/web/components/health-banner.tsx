'use client';

import type { HealthCheck } from '@app/types';
import { ChevronRight, CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { CommandSnippet } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { splitHint } from '@/lib/hint';
import { cn } from '@/lib/utils';

function CheckRow({ check }: { check: HealthCheck }) {
  // The command may be in `fix` (bare or inside a sentence) or at the end of `message` ("… Run: pip install x").
  const fromFix = splitHint(check.fix);
  const fromMessage = splitHint(check.message);
  const command = fromFix.command ?? fromMessage.command;
  const text = fromMessage.command ? fromMessage.text?.replace(/\s*(?:Run|run|with):$/, '') : check.message;
  return (
    <li className="grid gap-1.5">
      <p className="text-foreground">
        <span className="font-medium">{check.name}</span>
        <span className="text-muted-foreground"> — {text}</span>
      </p>
      {command && <CommandSnippet command={command} />}
    </li>
  );
}

/** Summarises failing checks from GET /system/health, with copyable fix commands. */
export function HealthBanner({ className, hideWhenHealthy = false }: { className?: string; hideWhenHealthy?: boolean }) {
  const [fresh, setFresh] = useState(0);
  const health = useApi(`health:${fresh}`, (signal) => api.health(fresh > 0, signal));
  const [open, setOpen] = useState(false);

  if (health.loading && !health.data) return <Skeleton className={cn('h-10 w-full', className)} />;
  if (health.error && !health.data) return <ApiErrorAlert error={health.error} className={className} onRetry={() => setFresh((n) => n + 1)} retryLabel="Check again" />;
  if (!health.data) return null;

  const failing = health.data.checks.filter((c) => !c.ok);
  const required = failing.filter((c) => c.required);
  const optional = failing.filter((c) => !c.required);
  const recheck = (
    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setFresh((n) => n + 1)} disabled={health.loading}>
      <RefreshCw className={cn('size-3.5', health.loading && 'animate-spin')} aria-hidden /> Re-check
    </Button>
  );

  if (!failing.length) {
    if (hideWhenHealthy) return null;
    return (
      <div className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}>
        <CircleCheck className="size-4 text-success" aria-hidden />
        <span>All {health.data.checks.length} local services are ready.</span>
        {recheck}
      </div>
    );
  }

  return (
    <div className={cn('grid gap-3', className)}>
      {required.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {required.length === 1 ? 'A required component is not ready' : `${required.length} required components are not ready`} — processing will fail until it is fixed.
            </span>
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1.5 grid w-full gap-3">
              {required.map((c) => (
                <CheckRow key={c.name} check={c} />
              ))}
            </ul>
            <div className="mt-1">{recheck}</div>
          </AlertDescription>
        </Alert>
      )}
      {optional.length > 0 && (
        <Alert variant="warning">
          <TriangleAlert aria-hidden />
          <AlertTitle>
            <button type="button" className="text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {optional.length === 1 ? '1 optional component is unavailable' : `${optional.length} optional components are unavailable`}
              <span className="font-normal text-muted-foreground">{`: ${optional.map((c) => c.name).join(', ')}`}</span>
              <ChevronRight className={cn('ml-1 inline size-4 align-[-3px] text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
            </button>
          </AlertTitle>
          {open && (
            <AlertDescription>
              <ul className="mt-1.5 grid w-full gap-3">
                {optional.map((c) => (
                  <CheckRow key={c.name} check={c} />
                ))}
              </ul>
              <div className="mt-1">{recheck}</div>
            </AlertDescription>
          )}
        </Alert>
      )}
    </div>
  );
}

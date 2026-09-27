'use client';

import type { HealthCheck } from '@app/types';
import { ChevronRight, CircleCheck, CircleX, RefreshCw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { useAppState } from '@/components/app-state';
import { CommandSnippet } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { splitHint } from '@/lib/hint';
import { cn } from '@/lib/utils';

/** The command may be in `fix` (bare or inside a sentence) or at the end of `message` ("… Run: pip install x"). */
function checkText(check: HealthCheck) {
  const fromFix = splitHint(check.fix);
  const fromMessage = splitHint(check.message);
  const command = fromFix.command ?? fromMessage.command;
  const text = fromMessage.command ? fromMessage.text?.replace(/\s*(?:Run|run|with):$/, '') : check.message;
  return { command, text };
}

function CheckRow({ check }: { check: HealthCheck }) {
  const { command, text } = checkText(check);
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

function RecheckButton({ className }: { className?: string }) {
  const { health } = useAppState();
  return (
    <Button variant="ghost" size="xs" className={cn('text-muted-foreground', className)} onClick={health.recheck} disabled={health.loading}>
      <RefreshCw className={cn('size-3.5', health.loading && 'animate-spin')} aria-hidden /> Re-check
    </Button>
  );
}

/**
 * Required components that are not ready (processing would fail), with copyable fix commands.
 * Optional ones only get a link to the System page, so they don't nag on every screen.
 */
export function HealthBanner({ className }: { className?: string }) {
  const { health } = useAppState();
  if (health.error && !health.data) return <ApiErrorAlert error={health.error} className={className} onRetry={health.recheck} retryLabel="Check again" />;
  if (!health.data) return null;
  const required = health.data.checks.filter((c) => !c.ok && c.required);
  if (!required.length) return null;

  return (
    <Alert variant="destructive" className={className}>
      <TriangleAlert aria-hidden />
      <AlertTitle>
        {required.length === 1 ? 'A required component is not ready' : `${required.length} required components are not ready`} — processing will fail until it is fixed.
      </AlertTitle>
      <AlertDescription>
        <ul className="mt-1.5 grid w-full gap-3">
          {required.map((c) => (
            <CheckRow key={c.name} check={c} />
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <RecheckButton />
          <Button asChild variant="ghost" size="xs" className="text-muted-foreground">
            <Link href="/system">
              All checks <ChevronRight aria-hidden />
            </Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Every check from GET /system/health — the System page. */
export function HealthChecks() {
  const { health } = useAppState();
  if (health.error && !health.data) return <ApiErrorAlert error={health.error} onRetry={health.recheck} retryLabel="Check again" />;
  if (!health.data)
    return (
      <div className="grid gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );

  const checks = [...health.data.checks].sort((a, b) => Number(a.ok) - Number(b.ok) || Number(b.required) - Number(a.required));
  const failingRequired = checks.filter((c) => !c.ok && c.required).length;
  const failingOptional = checks.filter((c) => !c.ok && !c.required).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm">
          {failingRequired ? (
            <CircleX className="size-4 text-destructive" aria-hidden />
          ) : failingOptional ? (
            <TriangleAlert className="size-4 text-warning" aria-hidden />
          ) : (
            <CircleCheck className="size-4 text-success" aria-hidden />
          )}
          <span>
            {failingRequired
              ? `${failingRequired} required component${failingRequired === 1 ? ' needs' : 's need'} attention`
              : failingOptional
                ? `Ready to process · ${failingOptional} optional component${failingOptional === 1 ? ' is' : 's are'} unavailable`
                : `All ${checks.length} local services are ready`}
          </span>
        </p>
        <RecheckButton />
      </div>
      <ul className="divide-y overflow-hidden rounded-xl border">
        {checks.map((c) => {
          const { command, text } = checkText(c);
          return (
            <li key={c.name} className={cn('grid gap-2 px-4 py-3', !c.ok && c.required && 'bg-destructive/[0.04]')}>
              <div className="flex items-start gap-3">
                {c.ok ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Ready" />
                ) : c.required ? (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Not ready" />
                ) : (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Unavailable" />
                )}
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                    {c.name}
                    {!c.required && (
                      <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                        Optional
                      </Badge>
                    )}
                  </p>
                  {text && <p className="text-sm break-words text-muted-foreground">{text}</p>}
                </div>
              </div>
              {!c.ok && command && <CommandSnippet command={command} className="ml-7" />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

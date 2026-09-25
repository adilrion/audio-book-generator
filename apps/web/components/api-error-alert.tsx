'use client';

import type { UserFacingError } from '@app/types';
import { CircleX, PlugZap, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { CommandSnippet } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Pull a runnable command out of hints like "Start it with: docker compose up -d redis". */
export function splitHint(hint?: string): { text?: string; command?: string } {
  if (!hint) return {};
  const m = hint.match(/^(.*?(?:with|run|Run|install|Install)\s*:?)\s+((?:pnpm|docker|brew|ollama|pip|npm|workers\/|\.venv|bash|python|cd)\S*.*)$/);
  if (m) return { text: m[1].replace(/[:\s]+$/, '') + ':', command: m[2].trim() };
  return { text: hint };
}

export function ErrorHint({ hint }: { hint?: string }) {
  const { text, command } = splitHint(hint);
  if (!text && !command) return null;
  return (
    <div className="mt-1 grid w-full gap-1.5 text-foreground/80">
      {text && <p>{text}</p>}
      {command && <CommandSnippet command={command} />}
    </div>
  );
}

/**
 * Friendly error block for API errors and pipeline errors. Never shows raw technical
 * details — the API already maps those to plain-language messages.
 */
export function ApiErrorAlert({
  error,
  title,
  onRetry,
  retryLabel = 'Try again',
  action,
  className,
}: {
  error: ApiError | UserFacingError;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
  className?: string;
}) {
  const unreachable = 'unreachable' in error && error.unreachable;
  return (
    <Alert variant="destructive" className={cn('items-start', className)}>
      {unreachable ? <PlugZap aria-hidden /> : <CircleX aria-hidden />}
      <AlertTitle>{title ?? error.message}</AlertTitle>
      <AlertDescription>
        {title && <p>{error.message}</p>}
        {unreachable ? (
          <div className="mt-1 grid w-full gap-1.5 text-foreground/80">
            <p>From the project folder, run:</p>
            <CommandSnippet command="pnpm dev" />
          </div>
        ) : (
          <ErrorHint hint={error.hint} />
        )}
        {(onRetry || action) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry} className="text-foreground">
                <RotateCcw aria-hidden /> {retryLabel}
              </Button>
            )}
            {action}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

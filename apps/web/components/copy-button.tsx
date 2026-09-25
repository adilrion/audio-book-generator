'use client';

import { Check, Copy } from 'lucide-react';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', className)}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

/** A shell command the user can copy, e.g. a fix from /system/health. */
export function CommandSnippet({ command, className }: { command: string; className?: string }) {
  return (
    <div className={cn('flex max-w-full items-center gap-1 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-2.5', className)}>
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">{command}</code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}

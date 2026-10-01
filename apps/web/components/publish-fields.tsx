'use client';

import { X } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { CopyButton } from '@/components/copy-button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** "64/100" — amber past `warn`, red past `max`. */
export function CharCount({ value, max, warn, className }: { value: number; max: number; warn?: number; className?: string }) {
  const tone = value > max ? 'text-destructive' : warn !== undefined && value > warn ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground';
  return (
    <span className={cn('text-xs tabular', tone, className)} aria-live="polite">
      {value.toLocaleString()}/{max.toLocaleString()}
    </span>
  );
}

/** A labelled field with an optional counter and copy button in the label row. */
export function PubField({
  label,
  htmlFor,
  counter,
  copy,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  counter?: ReactNode;
  copy?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <Label htmlFor={htmlFor} className="text-[13px]">
          {label}
        </Label>
        <span className="flex items-center gap-1.5">
          {counter}
          {copy !== undefined && <CopyButton text={copy} label="Copy" />}
        </span>
      </div>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Chips with an input: Enter, comma or Tab adds, Backspace on an empty input removes the last chip,
 * pasting "a, b, c" adds three. `clean` normalises each entry (an empty result is dropped).
 */
export function TagInput({
  id,
  value,
  onChange,
  clean,
  prefix,
  placeholder,
  disabled,
  invalid,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  clean: (raw: string) => string;
  prefix?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: (tag: string) => boolean;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const next = [...value];
    for (const part of raw.split(/[,\n]/)) {
      const t = clean(part);
      if (t && !next.some((x) => x.toLocaleLowerCase() === t.toLocaleLowerCase())) next.push(t);
    }
    if (next.length !== value.length) onChange(next);
    setText('');
  };

  return (
    <div
      className={cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={() => input.current?.focus()}
    >
      {value.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className={cn('inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-2 text-[13px]', invalid?.(t) && 'bg-destructive/12 text-destructive')}
        >
          <span className="truncate">
            {prefix}
            {t}
          </span>
          <button
            type="button"
            className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            aria-label={`Remove ${prefix ?? ''}${t}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((_, j) => j !== i));
            }}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        value={text}
        disabled={disabled}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (/[,\n]/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (/[,\n]/.test(t)) {
            e.preventDefault();
            add(text + t);
          }
        }}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/** A thin bar for budgets such as YouTube's 500 tag characters. */
export function Meter({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-foreground/10', className)} aria-hidden>
      <div className={cn('h-full rounded-full transition-[width]', value > max ? 'bg-destructive' : pct > 85 ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
    </div>
  );
}

'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '@/lib/utils';

/** `live` adds a moving sheen: the bar is still advancing even when the number has not changed. */
function Progress({
  className,
  value,
  indicatorClassName,
  live = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string; live?: boolean }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <ProgressPrimitive.Root data-slot="progress" value={v} className={cn('relative h-2 w-full overflow-hidden rounded-full bg-foreground/[0.07] dark:bg-foreground/10', className)} {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn('relative h-full w-full flex-1 overflow-hidden rounded-full bg-primary transition-transform duration-500 ease-out', indicatorClassName)}
        style={{ transform: `translateX(-${100 - v}%)` }}
      >
        {live && v > 0 && v < 100 && <span className="absolute inset-y-0 left-0 w-1/3 animate-sheen bg-linear-to-r from-transparent via-white/35 to-transparent" aria-hidden />}
      </ProgressPrimitive.Indicator>
    </ProgressPrimitive.Root>
  );
}

export { Progress };

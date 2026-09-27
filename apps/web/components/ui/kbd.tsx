import * as React from 'react';
import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-b-2 border-current/15 bg-current/[0.04] px-1 font-mono text-[10.5px] leading-none font-medium opacity-80',
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };

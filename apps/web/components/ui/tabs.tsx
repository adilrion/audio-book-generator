'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-3', className)} {...props} />;
}

/** `line` is the page-level style (underline under the active tab); `pill` is the compact switcher. */
function TabsList({ className, variant = 'pill', ...props }: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: 'pill' | 'line' }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        'group/tabs inline-flex w-fit items-center text-muted-foreground',
        variant === 'pill' && 'h-9 justify-center rounded-lg bg-muted p-[3px]',
        variant === 'line' && 'h-11 w-full justify-start gap-1 overflow-x-auto border-b scrollbar-thin',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-[color,box-shadow,background-color] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // pill
        'group-data-[variant=pill]/tabs:h-[calc(100%-1px)] group-data-[variant=pill]/tabs:flex-1 group-data-[variant=pill]/tabs:rounded-md group-data-[variant=pill]/tabs:border group-data-[variant=pill]/tabs:border-transparent group-data-[variant=pill]/tabs:px-3 group-data-[variant=pill]/tabs:py-1 group-data-[variant=pill]/tabs:text-foreground/70',
        'group-data-[variant=pill]/tabs:data-[state=active]:bg-background group-data-[variant=pill]/tabs:data-[state=active]:text-foreground group-data-[variant=pill]/tabs:data-[state=active]:shadow-sm dark:group-data-[variant=pill]/tabs:data-[state=active]:border-input dark:group-data-[variant=pill]/tabs:data-[state=active]:bg-input/30',
        // line
        'group-data-[variant=line]/tabs:h-full group-data-[variant=line]/tabs:rounded-t-md group-data-[variant=line]/tabs:px-3 group-data-[variant=line]/tabs:hover:text-foreground',
        'group-data-[variant=line]/tabs:after:absolute group-data-[variant=line]/tabs:after:inset-x-2 group-data-[variant=line]/tabs:after:-bottom-px group-data-[variant=line]/tabs:after:h-0.5 group-data-[variant=line]/tabs:after:rounded-full group-data-[variant=line]/tabs:after:bg-transparent group-data-[variant=line]/tabs:after:transition-colors',
        'group-data-[variant=line]/tabs:data-[state=active]:text-foreground group-data-[variant=line]/tabs:data-[state=active]:after:bg-foreground',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };

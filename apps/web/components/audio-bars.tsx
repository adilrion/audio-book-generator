import { cn } from '@/lib/utils';

const BARS = [
  { delay: 0, duration: 0.9 },
  { delay: 0.35, duration: 1.1 },
  { delay: 0.15, duration: 0.8 },
  { delay: 0.5, duration: 1.2 },
];

/** Small equaliser that moves while narration is being generated; flat when `paused`. */
export function AudioBars({ className, paused = false }: { className?: string; paused?: boolean }) {
  return (
    <span className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {BARS.map((b, i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-full bg-current', paused ? 'h-[35%]' : 'h-full animate-eq')}
          style={paused ? undefined : { animationDelay: `-${b.delay}s`, animationDuration: `${b.duration}s` }}
        />
      ))}
    </span>
  );
}

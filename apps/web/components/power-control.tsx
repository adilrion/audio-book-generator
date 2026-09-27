'use client';

import type { PerformanceMode, PerformancePrefs } from '@app/types';
import { BatteryMedium, Gauge, LoaderCircle, type LucideIcon, Moon, Pause, Play, Wind, Zap } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { useAppState } from '@/components/app-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import type { ApiError } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { estimateProcessingSec, powerSummary } from '@/lib/power';
import { cn } from '@/lib/utils';

export const MODE_ICONS: Record<PerformanceMode, LucideIcon> = { silent: Moon, quiet: Wind, balanced: Gauge, fast: Zap };

function usePowerUpdate() {
  const { performance } = useAppState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  async function update(patch: Partial<PerformancePrefs>, what: string) {
    setBusy(what);
    setError(undefined);
    setError(await performance.update(patch));
    setBusy(null);
  }
  return { status: performance, busy, error, update };
}

/**
 * Machine-wide power mode: how hard processing may push the Mac. Changes apply live — pause is
 * instant, a new mode applies from the next chapter.
 */
export function PowerControl({ narrationSec, withVideo = true, className, id }: { narrationSec?: number; withVideo?: boolean; className?: string; id?: string }) {
  const { anyActive } = useAppState();
  const { status, busy, error, update } = usePowerUpdate();
  const s = status.data;

  return (
    <Card id={id} className={cn('scroll-mt-24 gap-4', className)}>
      <CardHeader>
        <CardTitle>Power</CardTitle>
        <CardDescription>How hard processing may push this Mac. Cooler modes are quieter and slower; changes apply while a book is processing.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.error && !s && <ApiErrorAlert error={status.error} title="Power settings are unavailable" onRetry={() => void status.refresh()} />}
        {!s && !status.error && <Skeleton className="h-40" />}
        {s && (
          <>
            <div role="radiogroup" aria-label="Power mode" className="grid grid-cols-2 gap-2">
              {s.modes.map((m) => {
                const selected = s.prefs.mode === m.mode;
                const Icon = MODE_ICONS[m.mode] ?? Gauge;
                const eta = narrationSec ? estimateProcessingSec(s, m.mode, narrationSec, withVideo) : undefined;
                return (
                  <button
                    key={m.mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!!busy}
                    onClick={() => !selected && void update({ mode: m.mode }, m.mode)}
                    title={m.description}
                    className={cn(
                      'group grid gap-1.5 rounded-xl border bg-card p-3 text-left text-sm transition-[border-color,background-color,box-shadow] outline-none hover:border-foreground/20 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/10',
                      selected && 'border-foreground/70 bg-accent/40 ring-1 ring-foreground/70 hover:border-foreground/70 dark:bg-input/25',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn('grid size-7 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors', selected && 'bg-brand text-brand-foreground')}>
                        {busy === m.mode ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular">{eta ? `≈ ${formatDuration(eta)}` : m.cores}</span>
                    </span>
                    <span className="font-medium">
                      {m.label}
                      {m.mode === 'balanced' && <span className="font-normal text-muted-foreground"> · default</span>}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">{m.description}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <Label htmlFor="quiet-on-battery" className="flex items-center gap-2 text-sm font-normal">
                <BatteryMedium className="size-4 text-muted-foreground" aria-hidden /> Cool &amp; quiet while on battery
              </Label>
              <Switch id="quiet-on-battery" checked={s.prefs.quietOnBattery} disabled={!!busy} onCheckedChange={(c) => void update({ quietOnBattery: c }, 'battery')} />
            </div>
            <p className={cn('text-xs', s.plan.paused ? 'font-medium text-warning-foreground dark:text-warning' : 'text-muted-foreground')} aria-live="polite">
              {powerSummary(s)}
            </p>
            {(anyActive || s.prefs.paused) && (
              <Button variant={s.prefs.paused ? 'brand' : 'outline'} disabled={!!busy} onClick={() => void update({ paused: !s.prefs.paused }, 'pause')}>
                {busy === 'pause' ? <LoaderCircle className="animate-spin" aria-hidden /> : s.prefs.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
                {s.prefs.paused ? 'Resume processing' : 'Pause processing (cool down now)'}
              </Button>
            )}
            {error && <ApiErrorAlert error={error} title="Could not change the power mode" />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Sidebar widget: the current mode, and pause / resume while something is processing. */
export function PowerMini() {
  const { anyActive } = useAppState();
  const { status, busy, error, update } = usePowerUpdate();
  const s = status.data;
  if (!s) return null;
  const mode = s.plan.mode;
  const Icon = MODE_ICONS[mode] ?? Gauge;
  const label = s.modes.find((m) => m.mode === mode)?.label ?? mode;
  const paused = s.prefs.paused;

  return (
    <div className={cn('grid gap-2 rounded-xl border bg-card/70 p-2.5 shadow-card', paused && 'border-warning/50 bg-warning/[0.07]')}>
      <div className="flex items-center gap-2.5">
        <Link
          href="/system#power"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          title="Power settings"
        >
          <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground', paused && 'bg-warning/20 text-warning-foreground dark:text-warning')}>
            {paused ? <Pause className="size-4" aria-hidden /> : <Icon className="size-4" aria-hidden />}
          </span>
          <span className="grid min-w-0 leading-tight">
            <span className="text-[11px] text-muted-foreground">Power</span>
            <span className="truncate text-sm font-medium">{paused ? 'Paused' : label}</span>
          </span>
        </Link>
        {(anyActive || paused) && (
          <Button
            size="icon-sm"
            variant={paused ? 'brand' : 'ghost'}
            disabled={!!busy}
            onClick={() => void update({ paused: !paused }, 'pause')}
            aria-label={paused ? 'Resume processing' : 'Pause processing'}
            title={paused ? 'Resume processing' : 'Pause processing (cool down now)'}
          >
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </Button>
        )}
      </div>
      {error && <p className="px-0.5 text-xs text-destructive">{error.message}</p>}
    </div>
  );
}

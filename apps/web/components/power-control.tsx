'use client';

import type { PerformanceMode } from '@app/types';
import { BatteryMedium, Gauge, LoaderCircle, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, toApiError } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { estimateProcessingSec, powerSummary } from '@/lib/power';
import { cn } from '@/lib/utils';

/**
 * Machine-wide power mode: how hard processing may push the Mac. Changes apply live — pause is
 * instant, a new mode applies from the next chapter.
 */
export function PowerControl({ narrationSec, withVideo = true, active = false }: { narrationSec?: number; withVideo?: boolean; active?: boolean }) {
  const status = useApi('performance', (signal) => api.performance(signal), { interval: active ? 5000 : false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  const s = status.data;

  async function update(patch: Parameters<typeof api.setPerformance>[0], what: string) {
    setBusy(what);
    setError(undefined);
    try {
      status.mutate(await api.setPerformance(patch));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4" aria-hidden /> Power
        </CardTitle>
        <CardDescription>How hard processing may push this Mac. Cooler modes are quieter and slower; changes apply while a book is processing.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {status.error && !s && <ApiErrorAlert error={status.error} title="Power settings are unavailable" onRetry={() => void status.refresh()} />}
        {s && (
          <>
            <div role="radiogroup" aria-label="Power mode" className="grid gap-1.5">
              {s.modes.map((m) => {
                const selected = s.prefs.mode === m.mode;
                const eta = narrationSec ? estimateProcessingSec(s, m.mode, narrationSec, withVideo) : undefined;
                return (
                  <button
                    key={m.mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!!busy}
                    onClick={() => !selected && void update({ mode: m.mode as PerformanceMode }, m.mode)}
                    className={cn(
                      'grid gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selected && 'border-foreground/40 bg-accent/60',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {m.label}
                        {m.mode === 'balanced' && <span className="font-normal text-muted-foreground"> · default</span>}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular">
                        {busy === m.mode && <LoaderCircle className="size-3 animate-spin" aria-hidden />}
                        {eta ? `≈ ${formatDuration(eta)}` : m.cores}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{m.description}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="quiet-on-battery" className="flex items-center gap-1.5 text-sm font-normal">
                <BatteryMedium className="size-4 text-muted-foreground" aria-hidden /> Cool & quiet while on battery
              </Label>
              <Switch
                id="quiet-on-battery"
                checked={s.prefs.quietOnBattery}
                disabled={!!busy}
                onCheckedChange={(c) => void update({ quietOnBattery: c }, 'battery')}
              />
            </div>
            <p className={cn('text-xs', s.plan.paused ? 'font-medium text-warning' : 'text-muted-foreground')} aria-live="polite">
              {powerSummary(s)}
            </p>
            {(active || s.prefs.paused) && (
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

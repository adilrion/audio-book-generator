'use client';

import type { HealthReport, PerformancePrefs, PerformanceStatus, ProjectSummary } from '@app/types';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type ApiState, useApi } from '@/hooks/use-api';
import { type ApiError, api, toApiError } from '@/lib/api';
import { isActive } from '@/lib/stages';

export interface AppState {
  /** Every project, polled fast while something is processing. */
  projects: ApiState<ProjectSummary[]>;
  health: ApiState<HealthReport> & { recheck: () => void };
  /** Machine-wide power mode; `update` resolves with an error instead of throwing. */
  performance: ApiState<PerformanceStatus> & { update: (patch: Partial<PerformancePrefs>) => Promise<ApiError | undefined> };
  /** Some project is processing right now. */
  anyActive: boolean;
}

const AppStateContext = createContext<AppState | null>(null);

/**
 * One poller for the data the sidebar and the pages share (project list, system health, power
 * mode), so they never disagree and a change made in one place shows everywhere at once.
 */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [pollMs, setPollMs] = useState(15_000);
  const projects = useApi('projects', (signal) => api.listProjects(signal), { interval: pollMs });
  const anyActive = !!projects.data?.some((p) => isActive(p.status));

  // Poll fast while something is processing, slower while something is queued/not started.
  useEffect(() => {
    const list = projects.data ?? [];
    setPollMs(list.some((p) => isActive(p.status)) ? 2500 : list.some((p) => p.status === 'PENDING') ? 5000 : 15_000);
  }, [projects.data]);

  const [fresh, setFresh] = useState(0);
  const healthState = useApi(`health:${fresh}`, (signal) => api.health(fresh > 0, signal));
  const recheck = useCallback(() => setFresh((n) => n + 1), []);

  const perfState = useApi('performance', (signal) => api.performance(signal), { interval: anyActive ? 5000 : false });
  const { mutate: setPerf } = perfState;
  const update = useCallback(
    async (patch: Partial<PerformancePrefs>) => {
      try {
        setPerf(await api.setPerformance(patch));
        return undefined;
      } catch (e) {
        return toApiError(e);
      }
    },
    [setPerf],
  );

  const value = useMemo<AppState>(
    () => ({ projects, health: { ...healthState, recheck }, performance: { ...perfState, update }, anyActive }),
    [projects, healthState, recheck, perfState, update, anyActive],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used inside <AppStateProvider>');
  return ctx;
}

/** Summary of GET /system/health for badges: 'error' = a required check fails, 'warning' = an optional one. */
export function healthTone(report: HealthReport | undefined): 'ok' | 'warning' | 'error' | 'unknown' {
  if (!report) return 'unknown';
  const failing = report.checks.filter((c) => !c.ok);
  if (failing.some((c) => c.required)) return 'error';
  return failing.length ? 'warning' : 'ok';
}

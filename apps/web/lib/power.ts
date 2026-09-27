import type { PerformanceMode, PerformanceStatus } from '@app/types';

/** Estimated processing time for `narrationSec` of audio in a mode (from measured throughput). */
export function estimateProcessingSec(status: PerformanceStatus, mode: PerformanceMode, narrationSec: number, withVideo: boolean): number {
  const m = status.modes.find((x) => x.mode === mode);
  if (!m) return 0;
  return narrationSec / m.ttsSpeed + (withVideo ? narrationSec / m.videoSpeed : 0);
}

/** One-line description of what the worker does right now. */
export function powerSummary(status: PerformanceStatus): string {
  const p = status.plan;
  const label = status.modes.find((m) => m.mode === p.mode)?.label ?? p.mode;
  if (p.paused) return 'Paused — the laptop is idle; progress is kept.';
  const parts = [`${label}: ${p.ttsProcesses} voice process${p.ttsProcesses === 1 ? '' : 'es'} × ${p.ttsThreads} threads`];
  if (p.efficiencyCores) parts.push('efficiency cores only');
  if (p.reason === 'on battery') parts.push('switched to Cool & quiet because the Mac is on battery');
  return parts.join(' · ');
}

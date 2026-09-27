/**
 * How much of the Mac processing may use. Lower modes are slower but keep the laptop cool and quiet.
 * - silent:   efficiency cores only (macOS background QoS) — no fan noise, slowest; good overnight
 * - quiet:    about 2 cores
 * - balanced: about 4 cores — as fast as using every core for TTS, much cooler (default)
 * - fast:     everything the .env limits allow
 */
export type PerformanceMode = 'silent' | 'quiet' | 'balanced' | 'fast';

export const PERFORMANCE_MODES: PerformanceMode[] = ['silent', 'quiet', 'balanced', 'fast'];

export interface PerformancePrefs {
  mode: PerformanceMode;
  /** Use "quiet" while the Mac runs on battery (when balanced/fast is selected). */
  quietOnBattery: boolean;
  /** Freeze processing now (instant, keeps all progress). */
  paused: boolean;
}

export const DEFAULT_PERFORMANCE: PerformancePrefs = { mode: 'balanced', quietOnBattery: true, paused: false };

/** What the worker actually uses right now. */
export interface ResourcePlan {
  /** effective mode (may be lower than requested, e.g. on battery) */
  mode: PerformanceMode;
  requestedMode: PerformanceMode;
  reason?: string;
  paused: boolean;
  onBattery: boolean;
  ttsProcesses: number;
  ttsThreads: number;
  renderProcesses: number;
  renderThreads: number;
  /** macOS background QoS: runs on efficiency cores */
  efficiencyCores: boolean;
  /** Unix nice level for new processes */
  nice: number;
}

export interface PerformanceStatus {
  prefs: PerformancePrefs;
  /** what a worker would use now */
  plan: ResourcePlan;
  modes: { mode: PerformanceMode; label: string; description: string; ttsSpeed: number; videoSpeed: number; cores: string }[];
}

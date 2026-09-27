import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { PerformanceMode, PerformancePrefs, ResourcePlan } from '@app/types';
import { type Logger, silentLogger } from '@app/shared';
import type { PythonPool } from '../python/bridge';

export interface MachineInfo {
  cpuCount: number;
  /** Apple Silicon efficiency cores (0 when unknown / not Apple Silicon) */
  efficiencyCores: number;
  /** upper limits from .env, used by the "fast" mode */
  maxTts: number;
  maxRender: number;
}

const TASKPOLICY = '/usr/sbin/taskpolicy';
const canUseEfficiencyCores = process.platform === 'darwin' && fs.existsSync(TASKPOLICY);

function sysctlInt(name: string): number {
  try {
    return Number(execFileSync('sysctl', ['-n', name], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

export function machineInfo(maxTts: number, maxRender: number): MachineInfo {
  const cpuCount = os.availableParallelism?.() ?? os.cpus().length;
  const efficiencyCores = process.platform === 'darwin' ? sysctlInt('hw.perflevel1.logicalcpu') : 0;
  return { cpuCount, efficiencyCores, maxTts, maxRender };
}

/**
 * How much of the machine a mode may use. Measured on an M4 (10 cores) with Kokoro-82M:
 * 1 process × 10 threads = 5.0× realtime on 9.1 cores; 2 × 2 threads = 5.7× on 4 cores;
 * 2 × 3 = 6.2× on 5.8 cores; 1 × 2 = 2.9× on 2 cores. Kokoro scales poorly past ~3 threads,
 * so small processes are both faster and far cooler. Rendering is ~1.3 cores per worker
 * (OpenCV single-threaded is as fast as multi-threaded).
 */
export function planResources(prefs: PerformancePrefs, m: MachineInfo, onBattery: boolean): ResourcePlan {
  let mode: PerformanceMode = prefs.mode;
  let reason: string | undefined;
  if (onBattery && prefs.quietOnBattery && (mode === 'balanced' || mode === 'fast')) {
    mode = 'quiet';
    reason = 'on battery';
  }
  const base = { mode, requestedMode: prefs.mode, reason, paused: prefs.paused, onBattery };
  switch (mode) {
    case 'silent':
      // Efficiency cores only (macOS background QoS): no fan, slowest. Falls back to "quiet" elsewhere.
      if (canUseEfficiencyCores)
        return { ...base, ttsProcesses: 1, ttsThreads: Math.max(2, Math.min(4, m.efficiencyCores || 4)), renderProcesses: 1, renderThreads: 1, efficiencyCores: true, nice: 10 };
      return { ...base, ttsProcesses: 1, ttsThreads: 1, renderProcesses: 1, renderThreads: 1, efficiencyCores: false, nice: 15 };
    case 'quiet':
      return { ...base, ttsProcesses: 1, ttsThreads: 2, renderProcesses: 1, renderThreads: 1, efficiencyCores: false, nice: 10 };
    case 'fast': {
      const procs = Math.max(1, m.maxTts);
      return {
        ...base,
        ttsProcesses: procs,
        ttsThreads: Math.max(2, Math.floor((m.cpuCount * 0.6) / procs)),
        renderProcesses: Math.max(1, m.maxRender),
        renderThreads: 1,
        efficiencyCores: false,
        nice: 0,
      };
    }
    default: // balanced
      return {
        ...base,
        ttsProcesses: Math.min(2, Math.max(1, m.maxTts)),
        ttsThreads: 2,
        renderProcesses: Math.min(2, Math.max(1, m.maxRender)),
        renderThreads: 1,
        efficiencyCores: false,
        nice: 5,
      };
  }
}

/** Rough throughput per mode (× realtime), from the measurements above; used for time estimates. */
export const MODE_SPEED: Record<PerformanceMode, { tts: number; video: number; cores: string }> = {
  silent: { tts: 1.0, video: 2.5, cores: 'efficiency cores only' },
  quiet: { tts: 2.9, video: 6.4, cores: '≈ 2 cores' },
  balanced: { tts: 5.7, video: 12, cores: '≈ 4 cores' },
  fast: { tts: 6.2, video: 12, cores: 'all cores' },
};

export function estimateHours(narrationSec: number, mode: PerformanceMode, withVideo: boolean): number {
  const s = MODE_SPEED[mode];
  return (narrationSec / s.tts + (withVideo ? narrationSec / s.video : 0)) / 3600;
}

export function isOnBattery(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'batt'], { timeout: 3000 }, (err, out) => resolve(!err && /'Battery Power'/.test(out)));
  });
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (_e, out) => resolve(String(out ?? ''))));
}

async function descendants(pid: number): Promise<number[]> {
  const out = await run('pgrep', ['-P', String(pid)]);
  const kids = out.split('\n').map(Number).filter(Boolean);
  const deeper = await Promise.all(kids.map(descendants));
  return [...kids, ...deeper.flat()];
}

export type PoolRole = 'tts' | 'render' | 'main';

/**
 * Applies the current power mode to the running Python pools, live:
 * - pause/resume: SIGSTOP / SIGCONT the Python processes and their FFmpeg children (instant);
 * - efficiency cores: macOS background QoS on/off with `taskpolicy -b/-B -p` (instant);
 * - process count and threads: pools are reconfigured; the new sizes apply from the next chapter.
 */
export class PerformanceController {
  private prefs: PerformancePrefs;
  private onBattery = false;
  private plan: ResourcePlan;
  private readonly pools = new Map<PythonPool, PoolRole>();
  private timer?: NodeJS.Timeout;
  private lastBatteryCheck = 0;
  private stopped: number[] = [];
  private waiters: (() => void)[] = [];
  private listeners: ((p: ResourcePlan) => void)[] = [];

  constructor(
    private readonly machine: MachineInfo,
    initial: PerformancePrefs,
    private readonly readPrefs?: () => Promise<PerformancePrefs | undefined>,
    private readonly log: Logger = silentLogger,
    private readonly battery: () => Promise<boolean> = isOnBattery,
  ) {
    this.prefs = initial;
    this.plan = planResources(initial, machine, false);
  }

  get current(): ResourcePlan {
    return this.plan;
  }

  onChange(fn: (p: ResourcePlan) => void) {
    this.listeners.push(fn);
  }

  /** Environment for new Python processes of a role. */
  env(role: PoolRole): Record<string, string> {
    const p = this.plan;
    if (role === 'tts') return { KOKORO_THREADS: String(p.ttsThreads), OMP_NUM_THREADS: String(p.ttsThreads) };
    if (role === 'render') return { RENDER_THREADS: String(p.renderThreads), OMP_NUM_THREADS: String(p.renderThreads), OPENCV_NUM_THREADS: String(p.renderThreads) };
    return { OMP_NUM_THREADS: '1' };
  }

  size(role: PoolRole): number {
    return role === 'tts' ? this.plan.ttsProcesses : role === 'render' ? this.plan.renderProcesses : 1;
  }

  /** Command prefix for new processes (lower priority; efficiency cores in silent mode). */
  spawnPrefix(): string[] {
    const p = this.plan;
    const prefix: string[] = [];
    if (p.efficiencyCores && canUseEfficiencyCores) prefix.push(TASKPOLICY, '-b');
    if (p.nice > 0) prefix.push('/usr/bin/nice', '-n', String(p.nice));
    return prefix;
  }

  attach(pool: PythonPool, role: PoolRole) {
    this.pools.set(pool, role);
    pool.configure({ size: this.size(role), env: this.env(role), prefix: this.spawnPrefix(), gate: () => this.waitIfPaused() });
  }

  detach(pool: PythonPool) {
    this.pools.delete(pool);
  }

  /** Resolves immediately unless paused; then when resumed. */
  waitIfPaused(): Promise<void> {
    if (!this.plan.paused) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  async start(intervalMs = 3000) {
    await this.refresh(true);
    this.timer = setInterval(() => void this.refresh(false).catch((e) => this.log.warn('power mode refresh failed', e)), intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.plan.paused) await this.signalAll('SIGCONT');
    for (const w of this.waiters.splice(0)) w();
  }

  async refresh(force = false) {
    const next = (await this.readPrefs?.()) ?? this.prefs;
    if (force || Date.now() - this.lastBatteryCheck > 30_000) {
      this.onBattery = await this.battery();
      this.lastBatteryCheck = Date.now();
    }
    const prev = this.plan;
    this.prefs = next;
    this.plan = planResources(next, this.machine, this.onBattery);
    const p = this.plan;
    const changed = force || JSON.stringify(prev) !== JSON.stringify(p);
    if (!changed) return;
    for (const [pool, role] of this.pools) pool.configure({ size: this.size(role), env: this.env(role), prefix: this.spawnPrefix() });
    if (prev.efficiencyCores !== p.efficiencyCores || force) await this.applyQos(p.efficiencyCores);
    if (p.paused && !prev.paused) await this.signalAll('SIGSTOP');
    if (!p.paused && prev.paused) {
      await this.signalAll('SIGCONT');
      for (const w of this.waiters.splice(0)) w();
    }
    if (!force) this.log.info(`power mode: ${p.mode}${p.reason ? ` (${p.reason})` : ''}${p.paused ? ', paused' : ''}`);
    for (const l of this.listeners) l(p);
  }

  private async processTree(): Promise<number[]> {
    const roots = [...this.pools.keys()].flatMap((pool) => pool.pids());
    const kids = await Promise.all(roots.map(descendants));
    return [...roots, ...kids.flat()];
  }

  private async applyQos(efficiency: boolean) {
    if (!canUseEfficiencyCores) return;
    for (const pid of await this.processTree()) await run(TASKPOLICY, [efficiency ? '-b' : '-B', '-p', String(pid)]);
  }

  private async signalAll(sig: 'SIGSTOP' | 'SIGCONT') {
    const pids = sig === 'SIGSTOP' ? await this.processTree() : this.stopped.splice(0);
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
        if (sig === 'SIGSTOP') this.stopped.push(pid);
      } catch {
        /* already gone */
      }
    }
  }
}

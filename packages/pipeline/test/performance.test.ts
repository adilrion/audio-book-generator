import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import type { PerformancePrefs } from '@app/types';
import { PerformanceController, PythonPool, estimateHours, planResources, type MachineInfo } from '../src';

const M4: MachineInfo = { cpuCount: 10, efficiencyCores: 6, maxTts: 2, maxRender: 2 };
const prefs = (p: Partial<PerformancePrefs> = {}): PerformancePrefs => ({ mode: 'balanced', quietOnBattery: true, paused: false, ...p });
const cfg = loadConfig();
const hasPython = fs.existsSync(cfg.PYTHON_BIN);
const state = (pid: number) => execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('power modes', () => {
  it('balanced uses ~4 cores (2 × 2 threads), fast uses more, quiet ~2, silent the efficiency cores', () => {
    const b = planResources(prefs(), M4, false);
    expect([b.ttsProcesses, b.ttsThreads, b.renderProcesses]).toEqual([2, 2, 2]);
    const f = planResources(prefs({ mode: 'fast' }), M4, false);
    expect(f.ttsProcesses * f.ttsThreads).toBeGreaterThan(b.ttsProcesses * b.ttsThreads);
    const q = planResources(prefs({ mode: 'quiet' }), M4, false);
    expect([q.ttsProcesses, q.ttsThreads, q.renderProcesses]).toEqual([1, 2, 1]);
    const s = planResources(prefs({ mode: 'silent' }), M4, false);
    expect(s.ttsProcesses).toBe(1);
    if (process.platform === 'darwin') expect(s.efficiencyCores).toBe(true);
  });

  it('drops to quiet on battery unless disabled; never raises a lower mode', () => {
    expect(planResources(prefs({ mode: 'fast' }), M4, true)).toMatchObject({ mode: 'quiet', requestedMode: 'fast', reason: 'on battery' });
    expect(planResources(prefs({ mode: 'fast', quietOnBattery: false }), M4, true).mode).toBe('fast');
    expect(planResources(prefs({ mode: 'silent' }), M4, true).mode).toBe('silent');
  });

  it('estimates longer runs for cooler modes', () => {
    const h = (m: 'silent' | 'quiet' | 'balanced' | 'fast') => estimateHours(12 * 3600, m, true);
    expect(h('silent')).toBeGreaterThan(h('quiet'));
    expect(h('quiet')).toBeGreaterThan(h('balanced'));
    expect(h('balanced')).toBeGreaterThanOrEqual(h('fast'));
  });
});

describe.skipIf(!hasPython)('power controller on live processes', () => {
  it('pause freezes the Python process and holds new calls; resume continues them', async () => {
    let current = prefs({ mode: 'quiet' });
    const perf = new PerformanceController(M4, current, async () => current, undefined, async () => false);
    await perf.start(60_000);
    const pool = new PythonPool(cfg, 1);
    perf.attach(pool, 'main');
    try {
      await pool.call('ping', {});
      const [pid] = pool.pids();
      current = { ...current, paused: true };
      await perf.refresh();
      expect(state(pid)).toMatch(/^T/); // stopped
      let done = false;
      const pending = pool.call<{ pong: boolean }>('ping', {}).then((r) => ((done = true), r));
      await sleep(300);
      expect(done).toBe(false);
      current = { ...current, paused: false };
      await perf.refresh();
      expect((await pending).pong).toBe(true);
      expect(state(pid)).not.toMatch(/^T/);
    } finally {
      perf.detach(pool);
      await pool.shutdown();
      await perf.stop();
    }
  }, 30_000);

  it('a mode change reconfigures the pool: fresh processes get the new threads and priority', async () => {
    let current = prefs({ mode: 'balanced' });
    const perf = new PerformanceController(M4, current, async () => current, undefined, async () => false);
    await perf.start(60_000);
    const pool = new PythonPool(cfg, 1);
    perf.attach(pool, 'tts');
    try {
      await pool.call('ping', {});
      const [first] = pool.pids();
      expect(pool.size).toBe(2);
      current = { ...current, mode: 'quiet' };
      await perf.refresh();
      expect(pool.size).toBe(1);
      await pool.call('ping', {});
      const [second] = pool.pids();
      expect(second).not.toBe(first); // idle process with the old thread count was replaced
      expect(Number(execFileSync('ps', ['-o', 'nice=', '-p', String(second)]).toString().trim())).toBe(10);
    } finally {
      perf.detach(pool);
      await pool.shutdown();
      await perf.stop();
    }
  }, 30_000);
});

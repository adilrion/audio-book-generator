import type { PerformanceStatus } from '@app/types';
import { describe, expect, it } from 'vitest';
import { estimateProcessingSec, powerSummary } from '@/lib/power';

const status = (plan: Partial<PerformanceStatus['plan']> = {}): PerformanceStatus => ({
  prefs: { mode: 'balanced', quietOnBattery: true, paused: false },
  plan: { mode: 'balanced', requestedMode: 'balanced', paused: false, onBattery: false, ttsProcesses: 2, ttsThreads: 2, renderProcesses: 2, renderThreads: 1, efficiencyCores: false, nice: 5, ...plan },
  modes: [
    { mode: 'silent', label: 'Silent', description: '', ttsSpeed: 1, videoSpeed: 2.5, cores: '' },
    { mode: 'quiet', label: 'Cool & quiet', description: '', ttsSpeed: 2.9, videoSpeed: 6.4, cores: '' },
    { mode: 'balanced', label: 'Balanced', description: '', ttsSpeed: 5.7, videoSpeed: 12, cores: '' },
    { mode: 'fast', label: 'Fast', description: '', ttsSpeed: 6.2, videoSpeed: 12, cores: '' },
  ],
});

describe('power helpers', () => {
  it('estimates processing time per mode from measured throughput', () => {
    const s = status();
    expect(Math.round(estimateProcessingSec(s, 'balanced', 5.7 * 3600, false))).toBe(3600);
    expect(estimateProcessingSec(s, 'quiet', 36000, true)).toBeGreaterThan(estimateProcessingSec(s, 'balanced', 36000, true));
    expect(estimateProcessingSec(s, 'silent', 36000, true)).toBeGreaterThan(estimateProcessingSec(s, 'quiet', 36000, true));
  });
  it('explains what runs now, including the battery switch and pause', () => {
    expect(powerSummary(status())).toBe('Balanced: 2 voice processes × 2 threads');
    expect(powerSummary(status({ mode: 'quiet', reason: 'on battery', ttsProcesses: 1 }))).toContain('on battery');
    expect(powerSummary(status({ paused: true }))).toMatch(/^Paused/);
    expect(powerSummary(status({ mode: 'silent', efficiencyCores: true, ttsProcesses: 1, ttsThreads: 4 }))).toContain('efficiency cores only');
  });
});

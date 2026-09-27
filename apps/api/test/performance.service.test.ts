import { describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import type { PrismaService } from '../src/prisma/prisma.service';
import { PERFORMANCE_KEY, PerformanceService } from '../src/system/performance.service';

function setup(initial?: object) {
  let stored: unknown = initial;
  const prisma = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (where.key === PERFORMANCE_KEY && stored ? { key: PERFORMANCE_KEY, value: stored } : null),
      upsert: async (a: { create: { value: unknown } }) => {
        stored = a.create.value;
        return a.create;
      },
    },
  };
  return { svc: new PerformanceService(loadConfig(), prisma as unknown as PrismaService), stored: () => stored };
}

describe('power mode API', () => {
  it('defaults to the .env mode and lists every mode with measured speeds', async () => {
    const { svc } = setup();
    const s = await svc.status();
    expect(s.prefs).toMatchObject({ mode: loadConfig().PERFORMANCE_MODE, paused: false });
    expect(s.modes.map((m) => m.mode)).toEqual(['silent', 'quiet', 'balanced', 'fast']);
    expect(s.modes.find((m) => m.mode === 'balanced')!.ttsSpeed).toBeGreaterThan(s.modes.find((m) => m.mode === 'quiet')!.ttsSpeed);
  });

  it('stores partial updates and returns the new plan', async () => {
    const { svc, stored } = setup({ mode: 'balanced', quietOnBattery: true, paused: false });
    const s = await svc.update({ mode: 'silent' });
    expect(stored()).toMatchObject({ mode: 'silent', quietOnBattery: true, paused: false });
    expect(s.plan.requestedMode).toBe('silent');
    await svc.update({ paused: true });
    expect(stored()).toMatchObject({ mode: 'silent', paused: true });
    expect((await svc.status()).plan.paused).toBe(true);
  });

  it('rejects unknown modes and fields with a friendly 400', async () => {
    const { svc } = setup();
    await expect(svc.update({ mode: 'turbo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.update({ threads: 99 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

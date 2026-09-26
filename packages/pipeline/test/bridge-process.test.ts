import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@app/config';
import { PythonPool, PythonProcess } from '../src';

/**
 * Bridge tests against a tiny fake `audiobook_worker.server` (same JSON-lines protocol as
 * the real worker) so crash / timeout / abort behavior is deterministic and fast.
 */
const FAKE_SERVER = String.raw`
import json, os, sys, time
proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
def send(o):
    proto.write(json.dumps(o) + "\n"); proto.flush()
send({"event": "ready", "data": {"pid": os.getpid()}})
for line in sys.stdin:
    req = json.loads(line); i = req["id"]; m = req["method"]; p = req.get("params") or {}
    if m == "pid":
        send({"id": i, "result": os.getpid()})
    elif m == "sleep":
        n = int(p.get("steps", 10))
        for k in range(n):
            time.sleep(float(p.get("sec", 0.1)))
            send({"id": i, "event": "progress", "data": {"done": k + 1, "total": n}})
        send({"id": i, "result": "slept"})
    elif m == "big":
        send({"id": i, "result": "x" * int(p["n"])})
    elif m == "stderr":
        for k in range(int(p["lines"])):
            sys.stderr.write("noise %d %s\n" % (k, "y" * 200))
        sys.stderr.flush()
        send({"id": i, "result": "ok"})
    elif m == "crash":
        sys.stderr.write("fatal: simulated crash\n"); sys.stderr.flush()
        os._exit(3)
    elif m == "error":
        send({"id": i, "error": {"code": "TTS_FAILED", "message": "boom", "retryable": True}})
    elif m == "close_stdin_then_pid":
        os.close(0)
        send({"id": i, "result": os.getpid()})
        time.sleep(30)
`;

const base = loadConfig();
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fake-'));
fs.mkdirSync(path.join(fakeRoot, 'audiobook_worker'));
fs.writeFileSync(path.join(fakeRoot, 'audiobook_worker', '__init__.py'), '');
fs.writeFileSync(path.join(fakeRoot, 'audiobook_worker', 'server.py'), FAKE_SERVER);
const pythonBin = fs.existsSync(base.PYTHON_BIN) ? base.PYTHON_BIN : 'python3';
const cfg: AppConfig = { ...base, PYTHON_BIN: pythonBin, repoRoot: fakeRoot, workerDir: fakeRoot };

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const spawned: number[] = [];
const track = (pid: number) => (spawned.push(pid), pid);
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

afterAll(() => {
  for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  fs.rmSync(fakeRoot, { recursive: true, force: true });
});

describe('PythonProcess', () => {
  it('after a timeout kill, the respawned process is tracked as alive and reused (no leak)', async () => {
    const py = new PythonProcess(cfg);
    const first = track(await py.call<number>('pid', {}));
    await expect(py.call('sleep', { sec: 0.5, steps: 20 }, { timeoutMs: 150 })).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
    const second = track(await py.call<number>('pid', {}));
    expect(second).not.toBe(first);
    // Let the killed process's 'exit' event arrive; it must not mark the NEW process dead.
    await waitFor(() => !isAlive(first));
    await new Promise((r) => setTimeout(r, 100));
    expect(py.alive).toBe(true);
    const third = track(await py.call<number>('pid', {}));
    expect(third).toBe(second);
    await py.stop();
    expect(await waitFor(() => !isAlive(second))).toBe(true);
  });

  it('abort after the call was sent kills the process; abort before start never spawns', async () => {
    const py = new PythonProcess(cfg);
    const pid = track(await py.call<number>('pid', {}));
    const ac = new AbortController();
    const p = py.call('sleep', { sec: 0.2, steps: 50 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    await expect(py.call('pid', {}, { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(py.alive).toBe(false);
  });

  it('abort while the process is still starting cancels the call instead of running it', async () => {
    const py = new PythonProcess(cfg);
    const ac = new AbortController();
    const events: number[] = [];
    // Process not started yet: start() takes ~50–200 ms; abort lands in that window.
    const p = py.call('sleep', { sec: 0.1, steps: 20 }, { signal: ac.signal, onProgress: (e) => events.push(e.done) });
    setTimeout(() => ac.abort(), 5);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - t0).toBeLessThan(1500); // must not wait for the 2 s call to finish
    await new Promise((r) => setTimeout(r, 300));
    expect(events.length).toBe(0);
    py.kill();
  });

  it('crash rejects the in-flight call with WORKER_CRASHED + stderr tail, next call respawns', async () => {
    const py = new PythonProcess(cfg);
    const pid = track(await py.call<number>('pid', {}));
    const err = await py.call('crash', {}).catch((e) => e);
    expect(err).toMatchObject({ code: 'WORKER_CRASHED' });
    expect(JSON.stringify(err.details)).toContain('simulated crash');
    const pid2 = track(await py.call<number>('pid', {}));
    expect(pid2).not.toBe(pid);
    await py.stop();
  });

  it('writing to a worker whose stdin is gone rejects instead of crashing Node (EPIPE)', async () => {
    const py = new PythonProcess(cfg);
    const pid = track(await py.call<number>('close_stdin_then_pid', {}));
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      // Write a large request so the pipe write fails with EPIPE.
      const r = await Promise.race([
        py.call('big', { n: 10, pad: 'z'.repeat(1 << 20) }).then(
          () => 'resolved',
          (e) => e,
        ),
        new Promise((r) => setTimeout(() => r('pending'), 1000)),
      ]);
      await new Promise((r) => setTimeout(r, 200));
      expect(errors).toEqual([]);
      expect(r).not.toBe('resolved');
    } finally {
      process.off('uncaughtException', onUncaught);
      py.kill();
      await waitFor(() => !isAlive(pid));
    }
  });

  it('handles very large JSON lines and noisy stderr', async () => {
    const py = new PythonProcess(cfg);
    track(await py.call<number>('pid', {}));
    const big = await py.call<string>('big', { n: 8 * 1024 * 1024 });
    expect(big.length).toBe(8 * 1024 * 1024);
    expect(await py.call('stderr', { lines: 5000 })).toBe('ok');
    await py.stop();
  });

  it('does not accumulate abort listeners on a shared signal (no MaxListenersExceeded)', async () => {
    const py = new PythonProcess(cfg);
    const ac = new AbortController();
    const warnings: string[] = [];
    const onWarn = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarn);
    try {
      for (let i = 0; i < 40; i++) await py.call('pid', {}, { signal: ac.signal });
      for (let i = 0; i < 15; i++) await expect(py.call('error', {}, { signal: ac.signal, timeoutMs: 5000 })).rejects.toMatchObject({ code: 'TTS_FAILED' });
      await new Promise((r) => setTimeout(r, 50));
      expect(warnings.filter((w) => w === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarn);
      await py.stop();
    }
  });
});

describe('PythonPool', () => {
  it('runs calls concurrently across processes and recovers from a crashed member', async () => {
    const pool = new PythonPool(cfg, 2);
    const t0 = Date.now();
    const r = await Promise.all([pool.call('sleep', { sec: 0.1, steps: 5 }), pool.call('sleep', { sec: 0.1, steps: 5 }), pool.call<number>('pid', {})]);
    expect(r.slice(0, 2)).toEqual(['slept', 'slept']);
    expect(Date.now() - t0).toBeLessThan(1500);
    await expect(pool.call('crash', {})).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    const pids = await Promise.all([pool.call<number>('pid', {}), pool.call<number>('pid', {})]);
    pids.forEach(track);
    expect(pids.every(isAlive)).toBe(true);
    await pool.shutdown();
    expect(await waitFor(() => !pids.some(isAlive))).toBe(true);
  });

  it('killAll after a timeout leaves no live processes behind', async () => {
    const pool = new PythonPool(cfg, 1);
    await expect(pool.call('sleep', { sec: 0.5, steps: 20 }, { timeoutMs: 150 })).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
    const a = track(await pool.call<number>('pid', {}));
    await new Promise((r) => setTimeout(r, 150));
    const b = track(await pool.call<number>('pid', {}));
    await pool.shutdown();
    expect(await waitFor(() => !isAlive(a) && !isAlive(b))).toBe(true);
  });
});

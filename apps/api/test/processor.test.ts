import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@app/config';
import { CancelledError } from '@app/shared';
import type { ProgressSnapshot } from '@app/types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ProcessingWorker } from '../src/worker/processor';
import type { PrismaStore } from '../src/worker/prisma-store';

// ── fakes for BullMQ (worker + its Redis connection) and the pipeline runner ──────────────────

type RunFn = (store: PrismaStore, job: unknown, opts: { signal: AbortSignal; force?: boolean }) => Promise<unknown>;
const h = vi.hoisted(() => {
  const redis = new Map<string, string>();
  const client = {
    async set(key: string, value: string, _px: string, _ttl: number, nx: string) {
      if (nx === 'NX' && redis.has(key)) return null;
      redis.set(key, value);
      return 'OK' as const;
    },
    async get(key: string) {
      return redis.get(key) ?? null;
    },
    async eval(script: string, _n: number, key: string, token: string) {
      const cur = redis.get(key);
      if (/pexpire/.test(script)) {
        if (cur === token) return 1;
        if (cur === undefined) return redis.set(key, token), 1;
        return 0;
      }
      if (cur === token) return redis.delete(key), 1;
      return 0;
    },
  };
  const workers: { fn: (job: { data: unknown }) => Promise<unknown>; opts: Record<string, unknown>; running: boolean }[] = [];
  return { redis, client, workers, run: undefined as undefined | RunFn, runs: 0 };
});

vi.mock('bullmq', () => ({
  Worker: class {
    client = Promise.resolve(h.client);
    running = false;
    constructor(
      _name: string,
      public fn: (job: { data: unknown }) => Promise<unknown>,
      public opts: Record<string, unknown>,
    ) {
      if (opts.autorun !== false) this.running = true;
      h.workers.push(this);
    }
    on() {
      return this;
    }
    async run() {
      this.running = true;
    }
    async close() {
      this.running = false;
    }
  },
}));

vi.mock('@app/pipeline', () => ({
  PipelineRunner: class {
    constructor(
      _cfg: unknown,
      private readonly store: PrismaStore,
    ) {}
    run(job: unknown, opts: { signal: AbortSignal }) {
      h.runs++;
      return h.run!(this.store, job, opts);
    }
  },
}));

// ── in-memory tables with just enough of Prisma's `where` semantics ───────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (k === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, cond as Where);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[] };
      if (c.in) return c.in.includes(row[k]);
      if (c.notIn) return !c.notIn.includes(row[k]);
    }
    return row[k] === cond;
  });
}
function table(rows: Row[]) {
  return {
    rows,
    async findUnique({ where }: { where: Where }) {
      await Promise.resolve();
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    async findFirst({ where }: { where: Where }) {
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    async findMany({ where }: { where?: Where } = {}) {
      return rows.filter((x) => matches(x, where)).map((x) => ({ ...x }));
    },
    async update({ where, data }: { where: Where; data: Row }) {
      await Promise.resolve();
      const r = rows.find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      Object.assign(r, data);
      return { ...r };
    },
    async updateMany({ where, data }: { where: Where; data: Row }) {
      await Promise.resolve();
      const hit = rows.filter((x) => matches(x, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
}

const cfg = loadConfig();
const document = { id: 'doc-1', filePath: '/tmp/book.pdf', hash: 'h' };

function setup(state: { projects: Row[]; renderJobs: Row[]; steps?: Row[] }) {
  const project = table(state.projects.map((p) => ({ cancelRequested: false, settings: {}, name: 'Book', snapshot: null, progress: 0, documentId: 'doc-1', ...p })));
  const renderJob = table(state.renderJobs);
  const processingStep = table(state.steps ?? []);
  const withDoc = {
    ...project,
    async findUnique(args: { where: Where; include?: { document?: boolean } }) {
      const r = await project.findUnique(args);
      return r && args.include?.document ? { ...r, document } : r;
    },
  };
  const prisma = { project: withDoc, renderJob, processingStep };
  const worker = new ProcessingWorker(cfg, prisma as unknown as PrismaService);
  return { worker, project, renderJob, processingStep };
}

async function boot(w: ProcessingWorker) {
  const n = h.workers.length;
  await w.onApplicationBootstrap();
  const bull = h.workers[n];
  await vi.waitFor(() => expect(bull.running).toBe(true), { timeout: 2000 });
  return bull;
}

afterEach(() => {
  h.redis.clear();
  h.workers.length = 0;
  h.run = undefined;
  h.runs = 0;
});

describe('ProcessingWorker', () => {
  it('does not run a job that was cancelled while it waited in the queue', async () => {
    const t = setup({
      projects: [{ id: 'p1', status: 'CANCELLED', cancelRequested: true }],
      renderJobs: [{ id: 'rj1', projectId: 'p1', status: 'CANCELLED' }],
    });
    h.run = async () => ({});
    const bull = await boot(t.worker);
    await bull.fn({ data: { projectId: 'p1', renderJobId: 'rj1', force: false } });
    expect(h.runs).toBe(0);
    expect(t.renderJob.rows[0].status).toBe('CANCELLED');
    expect(t.project.rows[0]).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    await t.worker.onApplicationShutdown();
  });

  it('claims a queued job and runs it', async () => {
    const t = setup({ projects: [{ id: 'p1', status: 'PENDING' }], renderJobs: [{ id: 'rj1', projectId: 'p1', status: 'PENDING' }] });
    h.run = async (store) => {
      await store.updateSnapshot({ status: 'COMPLETED', progress: 100, updatedAt: new Date().toISOString() });
      return {};
    };
    const bull = await boot(t.worker);
    await bull.fn({ data: { projectId: 'p1', renderJobId: 'rj1', force: false } });
    expect(h.runs).toBe(1);
    expect(t.renderJob.rows[0].status).toBe('COMPLETED');
    expect(t.project.rows[0].status).toBe('COMPLETED');
    await t.worker.onApplicationShutdown();
  });

  it('marks the project failed when the run dies before the pipeline reported anything', async () => {
    const t = setup({ projects: [{ id: 'p1', status: 'PENDING', snapshot: { status: 'PENDING', message: 'Waiting for the worker…' } }], renderJobs: [{ id: 'rj1', projectId: 'p1', status: 'PENDING' }] });
    h.run = async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, mkdir'), { code: 'ENOSPC' });
    };
    const bull = await boot(t.worker);
    await bull.fn({ data: { projectId: 'p1', renderJobId: 'rj1', force: false } });
    expect(t.renderJob.rows[0].status).toBe('FAILED');
    const p = t.project.rows[0];
    expect(p.status).toBe('FAILED'); // not left "Waiting for the worker…" forever
    expect((p.snapshot as ProgressSnapshot).error).toMatchObject({ code: 'DISK_FULL', message: 'Your disk is full.' });
    await t.worker.onApplicationShutdown();
  });

  it('marks a run stopped by a worker shutdown as interrupted (resumable), not as cancelled by the user', async () => {
    const t = setup({ projects: [{ id: 'p1', status: 'PENDING' }], renderJobs: [{ id: 'rj1', projectId: 'p1', status: 'PENDING' }] });
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.run = async (store, _job, { signal }) => {
      await store.updateSnapshot({ status: 'GENERATING_AUDIO', progress: 40, updatedAt: new Date().toISOString() });
      started();
      await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
      // what the real runner does on abort
      await store.updateSnapshot({ status: 'CANCELLED', progress: 40, message: 'Processing was cancelled.', updatedAt: new Date().toISOString() });
      throw new CancelledError();
    };
    const bull = await boot(t.worker);
    const job = bull.fn({ data: { projectId: 'p1', renderJobId: 'rj1', force: false } });
    await running;
    await t.worker.onApplicationShutdown();
    await job;
    const p = t.project.rows[0];
    expect(p.status).toBe('FAILED');
    expect((p.snapshot as ProgressSnapshot).error).toMatchObject({ code: 'INTERRUPTED', retryable: true });
    expect(t.renderJob.rows[0].status).toBe('FAILED');
  });

  it('on start-up marks interrupted runs resumable, including a run claimed just before a crash', async () => {
    const t = setup({
      projects: [
        { id: 'p1', status: 'RENDERING', snapshot: { status: 'RENDERING', progress: 70 } },
        { id: 'p2', status: 'PENDING', snapshot: { status: 'PENDING', message: 'Waiting for the worker…' } }, // claimed, first snapshot never written
        { id: 'p3', status: 'PENDING', snapshot: { status: 'PENDING', message: 'Waiting for the worker…' } }, // still queued: untouched
      ],
      renderJobs: [
        { id: 'rj1', projectId: 'p1', status: 'RENDERING' },
        { id: 'rj2', projectId: 'p2', status: 'EXTRACTING' },
        { id: 'rj3', projectId: 'p3', status: 'PENDING' },
      ],
      steps: [{ projectId: 'p1', key: 'VIDEO_CHAPTER_1', status: 'RUNNING' }],
    });
    await boot(t.worker);
    const byId = (id: string) => t.project.rows.find((p) => p.id === id)!;
    for (const id of ['p1', 'p2']) {
      expect(byId(id).status).toBe('FAILED');
      expect((byId(id).snapshot as ProgressSnapshot).error).toMatchObject({ code: 'INTERRUPTED', retryable: true });
    }
    expect(byId('p3').status).toBe('PENDING');
    expect(t.renderJob.rows.map((j) => j.status)).toEqual(['FAILED', 'FAILED', 'PENDING']);
    expect(t.processingStep.rows[0].status).toBe('PENDING');
    await t.worker.onApplicationShutdown();
  });

  it('a second worker neither recovers nor takes jobs while another worker is running', async () => {
    const t = setup({ projects: [{ id: 'p1', status: 'RENDERING' }], renderJobs: [{ id: 'rj1', projectId: 'p1', status: 'RENDERING' }] });
    h.redis.set('audiobook:worker-lock', 'other-host:123:abcd'); // the first worker, alive and renewing
    const n = h.workers.length;
    await t.worker.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.workers[n].running).toBe(false);
    expect(t.project.rows[0].status).toBe('RENDERING');
    expect(t.renderJob.rows[0].status).toBe('RENDERING');
    await t.worker.onApplicationShutdown();
    expect(h.redis.get('audiobook:worker-lock')).toBe('other-host:123:abcd'); // not released by a non-owner
  });

  it('releases the worker lock on shutdown so a standby worker can take over', async () => {
    const t = setup({ projects: [], renderJobs: [] });
    await boot(t.worker);
    expect(h.redis.get('audiobook:worker-lock')).toMatch(/:\d+:/);
    await t.worker.onApplicationShutdown();
    expect(h.redis.has('audiobook:worker-lock')).toBe(false);
  });
});

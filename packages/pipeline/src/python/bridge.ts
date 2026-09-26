import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { AppConfig } from '@app/config';
import { AppError, CancelledError, type Logger, silentLogger } from '@app/shared';

export interface ProgressEvent {
  done: number;
  total: number;
  message?: string;
}

export interface CallOptions {
  onProgress?: (p: ProgressEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Error raised inside the Python worker. `code` maps to a user message via toAppError(). */
export class WorkerCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WorkerCallError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  opts: CallOptions;
  timer?: NodeJS.Timeout;
}

/**
 * One long-lived Python process speaking JSON lines. Models (Kokoro etc.) stay loaded
 * between calls. One request at a time per process — the pool provides parallelism.
 */
export class PythonProcess {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private stderrTail: string[] = [];
  private exited = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly env: Record<string, string> = {},
    private readonly log: Logger = silentLogger,
  ) {}

  get alive(): boolean {
    return !!this.proc && !this.exited;
  }

  start(): Promise<void> {
    if (this.ready && this.alive) return this.ready;
    this.exited = false;
    this.stderrTail = [];
    this.ready = new Promise<void>((resolve, reject) => {
      const proc = spawn(this.cfg.PYTHON_BIN, ['-u', '-m', 'audiobook_worker.server'], {
        cwd: this.cfg.repoRoot,
        env: {
          ...process.env,
          PYTHONPATH: this.cfg.workerDir,
          PYTHONUNBUFFERED: '1',
          KOKORO_MODEL_PATH: this.cfg.KOKORO_MODEL_PATH,
          KOKORO_VOICES_PATH: this.cfg.KOKORO_VOICES_PATH,
          KOKORO_PROVIDER: this.cfg.KOKORO_PROVIDER,
          PIPER_MODEL_DIR: this.cfg.PIPER_MODEL_DIR,
          ...this.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let started = false;
      // Events from a process we already killed and replaced must not touch the new one.
      const current = () => this.proc === proc;
      proc.on('error', (err) => {
        const e = new AppError('PYTHON_MISSING', 'The Python processing worker could not be started.', {
          hint: 'Run: pnpm setup:python',
          cause: err,
        });
        if (!started) reject(e);
        if (!current()) return;
        this.exited = true;
        this.failAll(e);
      });
      // A write to a dead worker fails with EPIPE; without a listener that crashes Node.
      proc.stdin.on('error', (err) => {
        this.log.warn(`python worker stdin: ${err.message}`);
        if (current()) this.kill(new AppError('WORKER_CRASHED', 'The processing worker stopped unexpectedly.', { cause: err, retryable: true }));
      });
      proc.on('exit', (code, sig) => {
        const tail = this.stderrTail.join('\n');
        const e = new AppError('WORKER_CRASHED', 'The processing worker stopped unexpectedly.', {
          details: { code, sig, stderr: tail.slice(-3000) },
          retryable: true,
        });
        if (!started) reject(e);
        if (!current()) return;
        this.exited = true;
        this.failAll(e);
      });
      readline.createInterface({ input: proc.stderr }).on('line', (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 60) this.stderrTail.shift();
        this.log.debug(`py: ${line}`);
      });
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg: { id?: number; event?: string; data?: any; result?: unknown; error?: any };
        try {
          msg = JSON.parse(line);
        } catch {
          this.log.debug(`py(stdout): ${line}`);
          return;
        }
        if (msg.event === 'ready') {
          started = true;
          resolve();
          return;
        }
        const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        if (msg.event === 'progress') p.opts.onProgress?.(msg.data as ProgressEvent);
        else if (msg.event === 'log') this.log.info(`py: ${msg.data?.message}`);
        else if (msg.error) {
          this.settle(msg.id!);
          p.reject(new WorkerCallError(msg.error.code, msg.error.message, msg.error.details, !!msg.error.retryable));
        } else if ('result' in msg) {
          this.settle(msg.id!);
          p.resolve(msg.result);
        }
      });
    });
    return this.ready;
  }

  private settle(id: number) {
    const p = this.pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private failAll(err: unknown) {
    for (const [id, p] of this.pending) {
      this.settle(id);
      p.reject(err);
    }
  }

  async call<T>(method: string, params: unknown, opts: CallOptions = {}): Promise<T> {
    if (opts.signal?.aborted) throw new CancelledError();
    await this.start();
    if (opts.signal?.aborted) throw new CancelledError(); // aborted while the worker was starting
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (v: unknown) => void, reject, opts };
      if (opts.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.kill(new AppError('WORKER_TIMEOUT', `Processing step "${method}" took too long and was stopped.`, { retryable: true }));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        const onAbort = () => {
          this.kill(new CancelledError()); // the only reliable way to stop a CPU-bound Python call
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        const done = (fn: (v: any) => void) => (v: any) => {
          opts.signal!.removeEventListener('abort', onAbort);
          fn(v);
        };
        pending.resolve = done(resolve);
        pending.reject = done(reject);
      }
      this.pending.set(id, pending);
      this.proc!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** SIGKILL the worker and reject its in-flight calls with `reason` right away (the
   *  'exit' event of a replaced process is ignored, so nothing else would settle them). */
  kill(reason: unknown = new CancelledError()): void {
    if (this.proc && !this.exited) {
      this.proc.kill('SIGKILL');
      this.exited = true;
    }
    this.failAll(reason);
  }

  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    this.proc.stdin.end();
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        this.kill();
        r();
      }, 3000);
      this.proc!.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

/** Fixed-size pool of Python processes. Processes are started lazily and can be shut down
 *  between stages to hand memory back (e.g. unload Kokoro before video rendering). */
export class PythonPool {
  private procs: PythonProcess[] = [];
  private idle: PythonProcess[] = [];
  private waiters: ((p: PythonProcess) => void)[] = [];

  constructor(
    private readonly cfg: AppConfig,
    readonly size: number,
    private readonly env: Record<string, string> = {},
    private readonly log: Logger = silentLogger,
  ) {}

  private async acquire(): Promise<PythonProcess> {
    const p = this.idle.pop();
    if (p) return p;
    if (this.procs.length < this.size) {
      const np = new PythonProcess(this.cfg, this.env, this.log);
      this.procs.push(np);
      return np;
    }
    return new Promise((r) => this.waiters.push(r));
  }

  private release(p: PythonProcess) {
    const w = this.waiters.shift();
    if (w) w(p);
    else this.idle.push(p);
  }

  async call<T>(method: string, params: unknown, opts: CallOptions = {}): Promise<T> {
    const p = await this.acquire();
    try {
      return await p.call<T>(method, params, opts);
    } finally {
      this.release(p);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.procs.map((p) => p.stop()));
    this.procs = [];
    this.idle = [];
  }

  killAll(): void {
    for (const p of this.procs) p.kill();
    this.procs = [];
    this.idle = [];
  }
}

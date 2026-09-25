/** Minimal counting semaphore to cap concurrent heavy work (TTS, render, LLM). */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Run `fn` over items with at most `limit` in flight. Fails fast on the first error. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (failed === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed;
  return results;
}

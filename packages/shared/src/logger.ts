type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'app', level: Level = (process.env.LOG_LEVEL as Level) || 'info'): Logger {
  const min = ORDER[level] ?? 20;
  const out = (lvl: Level, msg: string, meta?: unknown) => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    stream.write(meta === undefined ? `${line}\n` : `${line} ${typeof meta === 'string' ? meta : safeJson(meta)}\n`);
  };
  return {
    debug: (m, x) => out('debug', m, x),
    info: (m, x) => out('info', m, x),
    warn: (m, x) => out('warn', m, x),
    error: (m, x) => out('error', m, x),
    child: (s) => createLogger(`${scope}:${s}`, level),
  };
}

function safeJson(v: unknown): string {
  try {
    // Errors keep their code, details (e.g. a crashed worker's exit code, signal and stderr) and cause chain.
    return JSON.stringify(v, (_k, val) => {
      if (!(val instanceof Error)) return val;
      const e = val as Error & { code?: unknown; details?: unknown; cause?: unknown };
      return { name: e.name, message: e.message, code: e.code, details: e.details, cause: e.cause, stack: e.stack };
    });
  } catch {
    return String(v);
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

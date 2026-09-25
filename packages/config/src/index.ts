import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Walk up from `start` until the monorepo root (pnpm-workspace.yaml) is found. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (d: number) => z.coerce.number().int().default(d);

const schema = z.object({
  STORAGE_DIR: z.string().default('./storage'),
  DATABASE_URL: z.string().default('postgresql://audiobook:audiobook@localhost:5433/audiobook?schema=public'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  API_PORT: int(4000),
  MAX_UPLOAD_MB: int(500),
  PYTHON_BIN: z.string().default('./workers/processing/.venv/bin/python'),

  LLM_ENABLED: bool.default(true),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:4b'),
  LLM_TIMEOUT_MS: int(120_000),
  LLM_PRONUNCIATION: bool.default(false),

  TTS_ENGINE: z.enum(['kokoro', 'piper', 'say']).default('kokoro'),
  TTS_DEFAULT_VOICE: z.string().default('af_heart'),
  KOKORO_MODEL_PATH: z.string().default('./storage/models/kokoro/kokoro-v1.0.onnx'),
  KOKORO_VOICES_PATH: z.string().default('./storage/models/kokoro/voices-v1.0.bin'),
  KOKORO_PROVIDER: z.enum(['cpu', 'coreml']).default('cpu'),
  PIPER_MODEL_DIR: z.string().default('./storage/models/piper'),
  TTS_SAMPLE_RATE: int(24000),

  VIDEO_ENCODER: z.string().default('auto'),
  VIDEO_BITRATE: z.string().default('6M'),
  VIDEO_CRF: int(20),
  VIDEO_FPS: int(30),
  AUDIO_ENCODER: z.string().default('auto'),
  AUDIO_BITRATE: z.string().default('192k'),
  FFMPEG_BIN: z.string().default('ffmpeg'),
  FFPROBE_BIN: z.string().default('ffprobe'),

  MAX_CONCURRENT_TTS: int(2),
  MAX_CONCURRENT_PDF_RENDER: int(2),
  MAX_CONCURRENT_LLM: int(1),
  MAX_CONCURRENT_PROJECTS: int(1),
  DISK_RESERVE_GB: z.coerce.number().default(3),
  KEEP_INTERMEDIATE: bool.default(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type RawEnv = z.infer<typeof schema>;

export interface AppConfig extends RawEnv {
  repoRoot: string;
  storage: {
    root: string;
    uploads: string;
    extracted: string;
    audio: string;
    renders: string;
    output: string;
    models: string;
  };
  workerDir: string;
  cpuCount: number;
}

let cached: AppConfig | undefined;

export function loadConfig(overrides: Partial<RawEnv> = {}, opts: { reload?: boolean } = {}): AppConfig {
  if (cached && !opts.reload && Object.keys(overrides).length === 0) return cached;
  const repoRoot = findRepoRoot(__dirname);
  dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true } as dotenv.DotenvConfigOptions);
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const env = parsed.data;
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(repoRoot, p));
  const root = abs(env.STORAGE_DIR);
  const cfg: AppConfig = {
    ...env,
    PYTHON_BIN: abs(env.PYTHON_BIN),
    KOKORO_MODEL_PATH: abs(env.KOKORO_MODEL_PATH),
    KOKORO_VOICES_PATH: abs(env.KOKORO_VOICES_PATH),
    PIPER_MODEL_DIR: abs(env.PIPER_MODEL_DIR),
    MAX_CONCURRENT_TTS: Math.max(1, env.MAX_CONCURRENT_TTS),
    MAX_CONCURRENT_PDF_RENDER: Math.max(1, env.MAX_CONCURRENT_PDF_RENDER),
    MAX_CONCURRENT_LLM: Math.max(1, env.MAX_CONCURRENT_LLM),
    repoRoot,
    storage: {
      root,
      uploads: path.join(root, 'uploads'),
      extracted: path.join(root, 'extracted'),
      audio: path.join(root, 'audio'),
      renders: path.join(root, 'renders'),
      output: path.join(root, 'output'),
      models: path.join(root, 'models'),
    },
    workerDir: path.join(repoRoot, 'workers', 'processing'),
    cpuCount: os.availableParallelism?.() ?? os.cpus().length,
  };
  for (const dir of Object.values(cfg.storage)) fs.mkdirSync(dir, { recursive: true });
  if (Object.keys(overrides).length === 0) cached = cfg;
  return cfg;
}

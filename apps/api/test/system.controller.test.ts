import { describe, expect, it } from 'vitest';
import type { PythonPool } from '@app/pipeline';
import { AppError } from '@app/shared';
import type { AppConfig } from '../src/common/config.provider';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { QueueService } from '../src/queue/queue.service';
import type { PythonService } from '../src/system/python.service';
import { SystemController } from '../src/system/system.controller';

const cfg = { TTS_ENGINE: 'kokoro', TTS_DEFAULT_VOICE: 'af_heart', LLM_ENABLED: true, OLLAMA_MODEL: 'qwen3:4b', MAX_UPLOAD_MB: 500 } as AppConfig;
const python = { pool: {} as PythonPool } as PythonService;
const controller = () => new SystemController(cfg, {} as PrismaService, {} as QueueService, python);

describe('SystemController', () => {
  it('rejects an unknown voice engine with a 400-class error instead of INTERNAL', async () => {
    const err = await controller()
      .voices('elevenlabs')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'BAD_REQUEST', retryable: false });
    expect((err as AppError).hint).toContain('kokoro');
  });

  it('config() exposes defaults with the configured engine and voice', () => {
    const c = controller().config();
    expect(c.defaults.tts).toMatchObject({ engine: 'kokoro', voice: 'af_heart' });
    expect(c.engines).toEqual(expect.arrayContaining(['kokoro', 'piper', 'say']));
    expect(c.llm).toEqual({ enabled: true, model: 'qwen3:4b' });
    expect(c.maxUploadMb).toBe(500);
  });
});

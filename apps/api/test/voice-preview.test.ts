import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PythonPool } from '@app/pipeline';
import { AppError } from '@app/shared';
import type { AppConfig } from '../src/common/config.provider';
import type { PythonService } from '../src/system/python.service';
import { PREVIEW_TEXT, VoicePreviewController, previewSpeed, previewText } from '../src/system/voice-preview.controller';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A Python pool that knows two Kokoro voices and writes a fake WAV per synthesize call. */
function setup(available = true) {
  const audio = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-preview-'));
  dirs.push(audio);
  const calls: { voice: string; text: string; speed: number; language: string }[] = [];
  const pool = {
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === 'tts.engines')
        return { kokoro: { available, message: available ? 'ready' : 'Kokoro model files are missing. Run: pnpm setup:models' }, piper: { available: true, message: 'ready' } };
      if (method === 'tts.voices')
        return {
          available: true,
          voices: [
            { id: 'af_heart', name: 'Heart', language: 'en', gender: 'female' },
            { id: 'jf_alpha', name: 'Alpha', language: 'ja', gender: 'female' },
            { id: 'bn_BD-google-medium:4811', name: '4811', language: 'bn' },
            { id: 'bn_BD-google-medium:5233', name: '5233', language: 'bn' },
          ],
        };
      if (method === 'tts.synthesize') {
        calls.push({ voice: params.voice as string, text: params.text as string, speed: params.speed as number, language: params.language as string });
        await new Promise((r) => setTimeout(r, 5));
        fs.writeFileSync(params.outPath as string, 'RIFF');
        return { path: params.outPath, sampleRate: 24000, samples: 1, duration: 1 };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as PythonPool;
  const cfg = { TTS_ENGINE: 'kokoro', TTS_SAMPLE_RATE: 24000, storage: { audio } } as AppConfig;
  return { controller: new VoicePreviewController(cfg, { pool } as PythonService), calls, audio };
}

describe('voice preview', () => {
  it('synthesizes a sample once and serves it from storage afterwards', async () => {
    const { controller, calls, audio } = setup();
    const [a, b] = await Promise.all([controller.sample('kokoro', 'af_heart', 1, 'en'), controller.sample('kokoro', 'af_heart', 1, 'en')]);
    expect(a).toBe(b);
    expect(path.dirname(a)).toBe(path.join(audio, 'previews'));
    expect(fs.existsSync(a)).toBe(true);
    await controller.sample('kokoro', 'af_heart', 1, 'en');
    expect(calls).toEqual([{ voice: 'af_heart', text: PREVIEW_TEXT.en, speed: 1, language: 'en' }]);
    // another speed is another sample
    expect(await controller.sample('kokoro', 'af_heart', 1.25, 'en')).not.toBe(a);
    expect(calls).toHaveLength(2);
  });

  it('reads the sample in the voice’s own language', async () => {
    const { controller, calls } = setup();
    await controller.sample('kokoro', 'jf_alpha', 1, 'en');
    expect(calls[0]).toMatchObject({ text: PREVIEW_TEXT.ja, language: 'en' }); // Kokoro picks its phonemizer from the voice id
  });

  it('takes a multi-speaker model’s plain id for its first speaker, in the model’s language', async () => {
    const { controller, calls } = setup();
    await controller.sample('piper', 'bn_BD-google-medium', 1, 'en');
    expect(calls).toEqual([{ voice: 'bn_BD-google-medium:4811', text: PREVIEW_TEXT.bn, speed: 1, language: 'bn' }]);
  });

  it('refuses unknown engines and voices that are not installed', async () => {
    const { controller, calls } = setup();
    await expect(controller.sample('elevenlabs', 'x', 1)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(controller.sample('kokoro', '../../etc/passwd', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(controller.sample('kokoro', '', 1)).rejects.toBeInstanceOf(AppError);
    expect(calls).toEqual([]);
  });

  it('explains how to install a missing engine', async () => {
    const { controller } = setup(false);
    await expect(controller.sample('kokoro', 'af_heart', 1)).rejects.toMatchObject({ code: 'BAD_REQUEST', hint: expect.stringContaining('pnpm setup:models') });
  });

  it('picks the sample language and rounds the speed', () => {
    expect(previewText('bn', 'en')).toEqual({ text: PREVIEW_TEXT.bn, language: 'bn' });
    expect(previewText('en-us')).toEqual({ text: PREVIEW_TEXT.en, language: 'en' });
    expect(previewText('sw', 'bn').language).toBe('bn'); // no Swahili sample: the project language
    expect(previewText('sw').language).toBe('en');
    expect(previewSpeed('1.13')).toBe(1.15);
    expect(previewSpeed('9')).toBe(2);
    expect(previewSpeed('abc')).toBe(1);
    expect(previewSpeed(undefined)).toBe(1);
  });
});

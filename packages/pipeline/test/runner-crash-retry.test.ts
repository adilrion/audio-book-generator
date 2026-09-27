import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { AppError } from '@app/shared';
import { resolveSettings } from '@app/types';
import { MemoryStore, PipelineRunner, type PipelineJob, type TTSOptions, type TTSSegment } from '../src';
import { FakeTTS, hasFfmpeg, samplePdf } from './runner-fakes';

const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);

/** Simulates the Python TTS process dying (as under macOS memory pressure) for the first N calls. */
class CrashingTTS extends FakeTTS {
  constructor(private crashes: number) {
    super();
  }
  override async synthesizeSegments(segments: TTSSegment[], o: TTSOptions & { onProgress?: (p: { done: number; total: number }) => void }) {
    if (this.crashes-- > 0) throw new AppError('WORKER_CRASHED', 'The processing worker stopped unexpectedly.', { details: { sig: 'SIGKILL' } });
    return super.synthesizeSegments(segments, o);
  }
}

describe.skipIf(!hasPython || !hasFfmpeg)('runner: worker crash during a long run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-crash-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, MAX_CONCURRENT_TTS: 1 }, { reload: true });
  const pdf = path.join(tmp, 'book.pdf');
  const settings = resolveSettings({ outputMode: 'audiobook_only', text: { useLlm: false } });

  beforeAll(() => {
    samplePdf(cfg, pdf, 2, 2);
  });

  it('retries a chapter once after the worker process dies, and says so', async () => {
    const job: PipelineJob = { projectId: 'crash1', pdfPath: pdf, pdfHash: 'crash1', title: 'Crash', settings };
    const r = await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => new CrashingTTS(1) }).run(job);
    expect(r.outputs.map((o) => o.name)).toContain('audiobook.m4a');
    expect(r.warnings).toContain('A processing worker stopped unexpectedly and was restarted automatically.');
  });

  it('a second crash of the same chapter fails with the friendly chapter message', async () => {
    const job: PipelineJob = { projectId: 'crash2', pdfPath: pdf, pdfHash: 'crash2', title: 'Crash', settings: { ...settings, tts: { ...settings.tts, voice: 'am_adam' } } };
    const store = new MemoryStore();
    await expect(new PipelineRunner(cfg, store, undefined, { tts: () => new CrashingTTS(2) }).run(job)).rejects.toMatchObject({
      code: 'TTS_FAILED',
      message: 'Audio generation failed for Chapter 1.',
    });
  });
});

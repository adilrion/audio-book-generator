import { describe, expect, it } from 'vitest';
import { AppError, createLogger } from '@app/shared';

describe('developer logs', () => {
  it('keep a crashed worker’s exit details and the cause chain', () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const crash = new AppError('WORKER_CRASHED', 'The processing worker stopped unexpectedly.', { details: { code: null, sig: 'SIGKILL', stderr: 'Killed: 9' } });
      const top = new AppError('TTS_FAILED', 'Audio generation failed for Chapter 6.', { cause: crash });
      createLogger('t', 'debug').error('pipeline failed', top);
    } finally {
      process.stderr.write = orig;
    }
    const out = lines.join('');
    expect(out).toContain('"code":"TTS_FAILED"');
    expect(out).toContain('"sig":"SIGKILL"');
    expect(out).toContain('Killed: 9');
  });
});

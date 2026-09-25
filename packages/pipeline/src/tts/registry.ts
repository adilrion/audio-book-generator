import type { TTSEngineName } from '@app/types';
import type { PythonPool } from '../python/bridge';
import { PythonTTSProvider } from './python-provider';
import type { TTSProvider } from './types';

type Factory = (pool: PythonPool) => TTSProvider;

/**
 * TTS engine registry. To add an engine implemented in TypeScript (e.g. a local HTTP
 * TTS server), register a factory here; for a Python engine add it to
 * workers/processing/audiobook_worker/tts/registry.py and register a PythonTTSProvider.
 */
const factories = new Map<string, Factory>([
  ['kokoro', (pool) => new PythonTTSProvider('kokoro', pool)],
  ['piper', (pool) => new PythonTTSProvider('piper', pool)],
  ['say', (pool) => new PythonTTSProvider('say', pool)],
]);

export function registerTTSEngine(name: string, factory: Factory): void {
  factories.set(name, factory);
}

export function createTTSProvider(name: TTSEngineName | string, pool: PythonPool): TTSProvider {
  const f = factories.get(name);
  if (!f) throw new Error(`Unknown TTS engine: ${name}`);
  return f(pool);
}

export function ttsEngineNames(): string[] {
  return [...factories.keys()];
}

/** Recommended default voice per engine. */
export const DEFAULT_VOICES: Record<string, string> = {
  kokoro: 'af_heart',
  piper: 'en_US-lessac-medium',
  say: 'Samantha',
};

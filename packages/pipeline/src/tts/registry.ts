import type { LanguageCode, TTSEngineName, TTSSettings } from '@app/types';
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

/**
 * What a project in each language starts with: the engine, and the recommended voice per engine.
 * Bangla is narrated by Piper's bn_BD-google-medium (16 speakers; `stem:speaker` picks one) —
 * Kokoro has no Bangla voice. macOS has no built-in Bangla voice, so `say` only works with one
 * the user installed (found by its language).
 */
export const LANGUAGE_DEFAULTS: Record<LanguageCode, { engine: TTSEngineName; voices: Partial<Record<TTSEngineName, string>>; engines: TTSEngineName[] }> = {
  en: { engine: 'kokoro', voices: DEFAULT_VOICES, engines: ['kokoro', 'piper', 'say'] },
  bn: { engine: 'piper', voices: { piper: 'bn_BD-google-medium:4811' }, engines: ['piper', 'say'] },
};

const KOKORO_LANGS: Record<string, string> = { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' };

/** Language of a voice from its id, when the id says: Piper "bn_BD-google-medium:4811" → bn, Kokoro "af_heart" → en. */
export function voiceLanguage(voice: string): string | undefined {
  const piper = /^([a-z]{2,3})_[A-Z]{2}-/.exec(voice);
  if (piper) return piper[1];
  const kokoro = /^([a-z])[fm]_[a-z]+$/.exec(voice);
  return kokoro ? KOKORO_LANGS[kokoro[1]] : undefined;
}

/** Recommended voice for `engine` in a project in `language`. */
export function defaultVoice(engine: string, language: string): string | undefined {
  return LANGUAGE_DEFAULTS[language as LanguageCode]?.voices[engine as TTSEngineName] ?? (language === 'en' ? DEFAULT_VOICES[engine] : undefined);
}

/** Can `engine` narrate `language` at all (Kokoro has no Bangla voice)? */
export const canNarrate = (engine: string, language: LanguageCode) => LANGUAGE_DEFAULTS[language].engines.includes(engine as TTSEngineName);

/**
 * Voice settings after a change. Switching the language without choosing an engine moves to that
 * language's recommended engine and voice when the current engine cannot read it; switching it
 * without choosing a voice swaps a voice of the other language for the recommended one (an
 * English voice cannot read Bangla, and the reverse).
 */
export function voiceAfterChange(change: { language?: string; tts?: { engine?: string; voice?: string } }, merged: { language: LanguageCode; tts: TTSSettings }): TTSSettings {
  const lang = LANGUAGE_DEFAULTS[merged.language];
  const tts = merged.tts;
  if (change.language && !change.tts?.engine && !lang.engines.includes(tts.engine)) return { ...tts, engine: lang.engine, voice: defaultVoice(lang.engine, merged.language) ?? tts.voice };
  if (change.language && !change.tts?.voice && voiceLanguage(tts.voice) && voiceLanguage(tts.voice) !== merged.language)
    return { ...tts, voice: defaultVoice(tts.engine, merged.language) ?? tts.voice };
  return tts;
}

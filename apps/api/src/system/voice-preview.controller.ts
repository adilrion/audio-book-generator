import fs from 'node:fs';
import path from 'node:path';
import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createTTSProvider, ttsEngineNames } from '@app/pipeline';
import { hashKey } from '@app/shared';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';
import { badRequest, notFound } from '../common/errors';
import { PythonService } from './python.service';

/** What a voice says when previewed, by language: short (a few seconds), so the first sample comes quickly. */
export const PREVIEW_TEXT: Record<string, string> = {
  en: 'Hello! This is how I will sound reading your book, one page at a time.',
  bn: 'এটি একটি বাংলা কণ্ঠের নমুনা। শুনতে কেমন লাগছে?',
  es: '¡Hola! Así sonará mi voz al leer tu libro, página a página.',
  fr: 'Bonjour ! Voici comment je lirai votre livre, page après page.',
  de: 'Hallo! So klingt meine Stimme, wenn ich Ihr Buch vorlese.',
  it: 'Ciao! Ecco come suonerà la mia voce mentre leggo il tuo libro.',
  pt: 'Olá! É assim que a minha voz vai soar lendo o seu livro.',
  hi: 'नमस्ते! यह आवाज़ आपकी किताब को इसी तरह पढ़ेगी।',
  ja: 'こんにちは。この声であなたの本を読み上げます。',
  zh: '你好！我会用这个声音为你朗读这本书。',
};

const base = (lang: string | undefined) => (lang ?? '').toLowerCase().split(/[-_]/)[0];

/** The sample in the voice's own language, else the project's, else English. */
export function previewText(voiceLanguage: string, projectLanguage?: string): { text: string; language: string } {
  for (const l of [base(voiceLanguage), base(projectLanguage), 'en']) if (PREVIEW_TEXT[l]) return { text: PREVIEW_TEXT[l], language: l };
  return { text: PREVIEW_TEXT.en, language: 'en' };
}

/** Speed as the settings slider sets it (0.5–2.0), in steps of 0.05 so nearby values share one sample. */
export function previewSpeed(raw: string | undefined): number {
  const s = Number(raw);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.round(Math.min(2, Math.max(0.5, s)) * 20) / 20;
}

/**
 * GET /system/voices/preview?engine=kokoro&voice=af_heart&speed=1&language=en — a few seconds of the voice,
 * as WAV. Synthesized once per (engine, voice, speed, text) and kept in storage/audio/previews.
 */
@Controller('system/voices')
export class VoicePreviewController {
  /** Samples being synthesized, so a double click or two tabs don't synthesize the same one twice. */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly python: PythonService,
  ) {}

  @Get('preview')
  async preview(
    @Query('engine') engine: string | undefined,
    @Query('voice') voice: string | undefined,
    @Query('speed') speed: string | undefined,
    @Query('language') language: string | undefined,
    @Res() res: Response,
  ) {
    const file = await this.sample(engine ?? this.cfg.TTS_ENGINE, voice ?? '', previewSpeed(speed), language);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('audio/wav').sendFile(file, { acceptRanges: true });
  }

  async sample(engine: string, voice: string, speed: number, projectLanguage?: string): Promise<string> {
    const engines = ttsEngineNames();
    if (!engines.includes(engine)) throw badRequest(`Unknown voice engine "${engine.slice(0, 40)}".`, `Choose one of: ${engines.join(', ')}.`);
    if (!voice || voice.length > 200) throw badRequest('Choose a voice to preview.');
    const provider = createTTSProvider(engine, this.python.pool);
    const st = await provider.isAvailable();
    if (!st.ok) throw badRequest(`This voice engine is not installed.`, st.message);
    // Only installed voices: the id reaches the engine (Piper turns it into a model path).
    const info = (await provider.listVoices()).find((v) => v.id === voice);
    if (!info) throw notFound('Voice');

    const { text, language } = previewText(info.language, projectLanguage);
    // Kokoro picks the right phonemizer from the voice id when asked for 'en' (see kokoro_engine.py).
    const engineLanguage = engine === 'kokoro' ? 'en' : language;
    const sampleRate = this.cfg.TTS_SAMPLE_RATE;
    const key = hashKey('voice-preview-v1', engine, provider.version, voice, speed, engineLanguage, text, sampleRate);
    const file = path.join(this.cfg.storage.audio, 'previews', `${key}.wav`);
    if (fs.existsSync(file)) return file;

    let job = this.pending.get(key);
    if (!job) {
      job = (async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await provider.synthesize(text, { voice, speed, language: engineLanguage, sampleRate, outPath: file });
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    await job;
    return file;
  }
}

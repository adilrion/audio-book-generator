import type { TTSEngineName, VoiceInfo } from '@app/types';

export const ENGINE_LABELS: Record<TTSEngineName, { name: string; description: string }> = {
  kokoro: { name: 'Kokoro', description: 'Natural neural voices (recommended)' },
  piper: { name: 'Piper', description: 'Fast, lightweight neural voices' },
  say: { name: 'macOS voices', description: 'Built-in system voices' },
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  bn: 'Bangla',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  hi: 'Hindi',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  ru: 'Russian',
  nl: 'Dutch',
  sv: 'Swedish',
  nb: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  pl: 'Polish',
  tr: 'Turkish',
  ar: 'Arabic',
  he: 'Hebrew',
  id: 'Indonesian',
  ms: 'Malay',
  th: 'Thai',
  vi: 'Vietnamese',
  cs: 'Czech',
  el: 'Greek',
  hu: 'Hungarian',
  ro: 'Romanian',
  sk: 'Slovak',
  uk: 'Ukrainian',
  ca: 'Catalan',
  hr: 'Croatian',
  bg: 'Bulgarian',
};

let displayNames: Intl.DisplayNames | null | undefined;

/** English name of a language code; the engines report many (macOS `say` alone has ~35). */
export function languageName(code: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0];
  if (LANGUAGE_NAMES[base]) return LANGUAGE_NAMES[base];
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    } catch {
      displayNames = null;
    }
  }
  let name: string | undefined;
  try {
    name = displayNames?.of(base);
  } catch {
    name = undefined; // not a well-formed language code
  }
  return name && name.toLowerCase() !== base ? name : code.toUpperCase();
}

/** Accent hint from well-known voice id conventions (Kokoro af_/bf_, Piper en_US-/en_GB-). */
export function voiceAccent(v: VoiceInfo): string | undefined {
  if (v.engine === 'kokoro') {
    if (/^a[fm]_/.test(v.id)) return 'US';
    if (/^b[fm]_/.test(v.id)) return 'UK';
    return undefined;
  }
  const m = v.id.match(/^[a-z]{2}_([A-Z]{2})\b/);
  return m ? m[1] : undefined;
}

const GENDER_LABELS = { female: 'Female', male: 'Male', neutral: 'Neutral' } as const;

/** "Female · US" */
export function voiceMeta(v: VoiceInfo): string {
  return [v.gender ? GENDER_LABELS[v.gender] : undefined, voiceAccent(v)].filter(Boolean).join(' · ');
}

export interface VoiceGroup {
  language: string;
  label: string;
  voices: VoiceInfo[];
}

/** Group voices by language; the project's language first, then alphabetical. */
export function groupVoices(voices: VoiceInfo[], preferred: string): VoiceGroup[] {
  const map = new Map<string, VoiceInfo[]>();
  for (const v of voices) {
    const lang = (v.language || 'other').toLowerCase().split(/[-_]/)[0];
    const list = map.get(lang);
    if (list) list.push(v);
    else map.set(lang, [v]);
  }
  const genderOrder = { female: 0, male: 1, neutral: 2 } as const;
  return [...map.entries()]
    .map(([language, list]) => ({
      language,
      label: languageName(language),
      voices: list.sort(
        (a, b) =>
          (voiceAccent(a) ?? '').localeCompare(voiceAccent(b) ?? '') ||
          (a.gender ? genderOrder[a.gender] : 3) - (b.gender ? genderOrder[b.gender] : 3) ||
          a.name.localeCompare(b.name),
      ),
    }))
    .sort((a, b) => (a.language === preferred ? -1 : b.language === preferred ? 1 : a.label.localeCompare(b.label)));
}

/** Best voice for an engine: the configured default if installed, else the first voice in the project language. */
export function pickVoice(voices: VoiceInfo[], preferredId: string | undefined, language: string): string | undefined {
  if (preferredId && voices.some((v) => v.id === preferredId)) return preferredId;
  return (voices.find((v) => v.language.startsWith(language)) ?? voices[0])?.id;
}

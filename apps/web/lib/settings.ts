import type { DeepPartial, ProjectSettings, Stage, TextSettings } from '@app/types';

/** Body for PATCH /projects/:id/settings — a partial ProjectSettings where `chapterRange: null` clears the range. */
export type SettingsPatch = Omit<DeepPartial<ProjectSettings>, 'text'> & {
  text?: Omit<DeepPartial<TextSettings>, 'chapterRange'> & { chapterRange?: { from: number; to: number } | null };
};

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlain(a) && isPlain(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!equal(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/**
 * Minimal patch that turns `base` into `next`. Only changed leaves are sent, so the server's
 * content-addressed cache can reuse every stage the change does not affect.
 */
export function diffSettings(base: ProjectSettings, next: ProjectSettings): SettingsPatch {
  const patch: Plain = {};
  const b = base as unknown as Plain;
  const n = next as unknown as Plain;
  for (const key of Object.keys(n)) {
    const bv = b[key];
    const nv = n[key];
    if (isPlain(nv)) {
      const section: Plain = {};
      const bs = isPlain(bv) ? bv : {};
      for (const k of new Set([...Object.keys(nv), ...Object.keys(bs)])) {
        if (equal(bs[k], nv[k])) continue;
        // A removed optional value (e.g. chapterRange) must be cleared explicitly.
        section[k] = nv[k] === undefined ? null : nv[k];
      }
      if (Object.keys(section).length) patch[key] = section;
    } else if (!equal(bv, nv)) {
      patch[key] = nv;
    }
  }
  return patch as SettingsPatch;
}

export const isEmptyPatch = (p: SettingsPatch) => Object.keys(p).length === 0;

/** Returns a user-facing problem with the settings, or undefined when they can be submitted. */
export function validateSettings(s: ProjectSettings): string | undefined {
  const r = s.text.chapterRange;
  if (r) {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < 1) return 'Chapter numbers must be whole numbers starting at 1.';
    if (r.from > r.to) return 'The first chapter must not be after the last chapter.';
  }
  if (!s.tts.voice) return 'Choose a voice.';
  if (s.language === 'bn') return 'Bangla narration is coming soon.';
  return undefined;
}

/**
 * Settings to send with POST /projects. The upload happens as soon as a file is dropped, while
 * the form may be half-edited; the API rejects invalid settings, which would make the *upload*
 * fail. So send the whole form only when it is valid — otherwise just the OCR mode, which is the
 * one setting the upload itself checks (a scanned PDF with OCR off is refused). Everything else is
 * applied with PATCH /settings when the user presses Start.
 */
export function settingsForUpload(s: ProjectSettings): ProjectSettings | SettingsPatch {
  return validateSettings(s) ? { text: { ocr: s.text.ocr } } : s;
}

export function cloneSettings(s: ProjectSettings): ProjectSettings {
  return JSON.parse(JSON.stringify(s)) as ProjectSettings;
}

const PIPELINE: Stage[] = ['EXTRACT', 'CLEAN', 'ANALYZE', 'TTS', 'AUDIO_MERGE', 'TIMELINE', 'VIDEO', 'MUX'];
const from = (stage: Stage) => PIPELINE.slice(PIPELINE.indexOf(stage));

/**
 * Which stages a settings change forces the pipeline to recompute (mirrors the cache keys in
 * packages/pipeline). Everything else is reused from cache. Used for UI copy only — the server decides.
 */
export function affectedStages(patch: SettingsPatch, next: ProjectSettings): Stage[] {
  const hit = new Set<Stage>();
  const add = (stages: Stage[]) => stages.forEach((s) => hit.add(s));
  const video = next.outputMode === 'audiobook_video';

  if (patch.language !== undefined || patch.text?.ocr !== undefined) add(from('EXTRACT'));
  if (patch.text?.useLlm !== undefined || patch.text?.skipFrontMatter !== undefined) add(from('CLEAN'));
  if (patch.text && 'chapterRange' in patch.text) add(from('TTS'));
  if (patch.tts || patch.audio?.sentencePauseMs !== undefined || patch.audio?.paragraphPauseMs !== undefined || patch.audio?.chapterPauseMs !== undefined)
    add(from('TTS'));
  if (patch.audio?.normalize !== undefined) add(['AUDIO_MERGE', 'MUX']);
  if (patch.video?.fps !== undefined || patch.video?.highlightMode !== undefined) add(['TIMELINE', 'VIDEO', 'MUX']);
  const v = patch.video ?? {};
  const renderKeys = Object.keys(v).filter((k) => !['fps', 'highlightMode', 'embedSubtitles'].includes(k));
  if (renderKeys.length) add(['VIDEO', 'MUX']);
  if (v.embedSubtitles !== undefined) add(['MUX']);
  if (patch.outputMode === 'audiobook_video') add(['VIDEO', 'MUX']);

  return PIPELINE.filter((s) => hit.has(s) && (video || (s !== 'VIDEO' && s !== 'MUX')));
}

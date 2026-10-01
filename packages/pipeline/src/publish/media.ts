import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@app/config';
import { AppError, assertDiskSpace } from '@app/shared';
import { type EmbeddedTags, type LanguageCode, languageTag } from '@app/types';
import { run } from '../audio/ffmpeg';

/**
 * Write metadata (and cover art) into a finished MP4 / M4A without re-encoding: every stream is
 * copied, chapters are kept, and the result replaces the original only after it was checked.
 */

export interface MediaTagJob {
  file: string;
  kind: 'video' | 'audio';
  /** ffmpeg `-metadata` keys; an empty value removes the tag. */
  tags: Record<string, string>;
  /** JPEG/PNG to embed as cover art (replaces any cover already embedded). */
  cover?: string;
  language: LanguageCode;
  signal?: AbortSignal;
}

interface ProbeJson {
  format?: { duration?: string; size?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; codec_name?: string; disposition?: { attached_pic?: number } }[];
  chapters?: unknown[];
}

async function probeJson(cfg: AppConfig, file: string): Promise<ProbeJson> {
  const out = await run(cfg.FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:format_tags:stream=codec_type,codec_name:stream_disposition=attached_pic',
    '-show_chapters', '-of', 'json', file,
  ]);
  return JSON.parse(out) as ProbeJson;
}

/** What is embedded in the file now: global tags, cover art, chapter count. */
export async function readMediaTags(cfg: AppConfig, file: string): Promise<Omit<EmbeddedTags, 'name'> & { duration: number }> {
  const j = await probeJson(cfg, file);
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(j.format?.tags ?? {})) {
    const key = k.toLowerCase();
    if (['major_brand', 'minor_version', 'compatible_brands'].includes(key)) continue;
    tags[key] = v;
  }
  return {
    size: Number(j.format?.size ?? 0),
    duration: Number(j.format?.duration ?? 0),
    tags,
    hasCover: (j.streams ?? []).some((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1),
    chapters: j.chapters?.length ?? 0,
  };
}

export async function writeMediaTags(cfg: AppConfig, job: MediaTagJob): Promise<void> {
  const st = await fsp.stat(job.file);
  await assertDiskSpace(path.dirname(job.file), st.size + 32 * 1024 * 1024, cfg.DISK_RESERVE_GB * 1024 ** 3, 'writing the metadata');
  const before = await probeJson(cfg, job.file);
  const ext = path.extname(job.file);
  const tmp = `${job.file}.tags.tmp${ext}`;
  const lang = languageTag(job.language);

  const args = ['-hide_banner', '-v', 'error', '-y', '-i', job.file];
  if (job.cover) args.push('-i', job.cover);
  // `V` = video streams that are not cover art, so an earlier cover is replaced, not duplicated.
  // The QuickTime chapter text track is not mapped: ffmpeg rebuilds it from -map_chapters.
  if (job.kind === 'video') args.push('-map', '0:V', '-map', '0:a', '-map', '0:s?');
  else args.push('-map', '0:a');
  if (job.cover) args.push('-map', '1:v:0');
  args.push('-c', 'copy');
  if (job.cover) args.push(`-disposition:v:${job.kind === 'video' ? 1 : 0}`, 'attached_pic');
  args.push('-map_metadata', '0', '-map_chapters', '0');
  for (const [k, v] of Object.entries(job.tags)) args.push('-metadata', `${k}=${v}`);
  args.push('-metadata:s:a:0', `language=${lang}`);
  if (job.kind === 'video' && before.streams?.some((s) => s.codec_type === 'subtitle')) args.push('-metadata:s:s:0', `language=${lang}`);
  args.push('-movflags', '+faststart', tmp);

  try {
    await run(cfg.FFMPEG_BIN, args, { signal: job.signal });
    const after = await probeJson(cfg, tmp);
    const d0 = Number(before.format?.duration ?? 0);
    const d1 = Number(after.format?.duration ?? 0);
    const has = (j: ProbeJson, t: string) => (j.streams ?? []).some((s) => s.codec_type === t && s.disposition?.attached_pic !== 1);
    if (Math.abs(d0 - d1) > 0.25 || !has(after, 'audio') || (job.kind === 'video' && !has(after, 'video')))
      throw new AppError('OUTPUT_INVALID', 'Writing the metadata produced an unexpected file, so the original was kept.', { details: { before: d0, after: d1 } });
    await fsp.rename(tmp, job.file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

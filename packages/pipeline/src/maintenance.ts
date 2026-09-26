import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@app/config';
import { dirSize, fileSize, readJsonIfExists, removeTempSiblings, rmrf } from '@app/shared';
import { CachePaths, type ProjectManifest } from './pipeline/paths';

const manifestKeys = (m: ProjectManifest | undefined) => ({
  audio: [...(m?.audioKeys ?? []), ...(m?.cacheKeys?.audio ?? [])],
  video: [...(m?.videoKeys ?? []), ...(m?.cacheKeys?.video ?? [])],
});

/** Cache keys + PDFs referenced by every OTHER project (cache entries are content-addressed and shared). */
async function referencedElsewhere(cfg: AppConfig, projectId: string) {
  const audio = new Set<string>();
  const video = new Set<string>();
  const pdfHashes = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = await fsp.readdir(cfg.storage.output);
  } catch {
    /* no outputs yet */
  }
  for (const d of dirs) {
    if (d === projectId) continue;
    const m = await readJsonIfExists<ProjectManifest>(path.join(cfg.storage.output, d, 'manifest.json')).catch(() => undefined);
    if (!m) continue;
    const k = manifestKeys(m);
    k.audio.forEach((x) => audio.add(x));
    k.video.forEach((x) => video.add(x));
    if (m.pdfHash) pdfHashes.add(m.pdfHash);
  }
  return { audio, video, pdfHashes };
}

/**
 * "Clean project cache": remove intermediate/cached data for a project but NEVER the final
 * outputs (audiobook.mp4 / .m4a / subtitles.srt), and never cache entries another project
 * still references (same PDF / identical narration). Returns bytes freed.
 */
export async function cleanProjectCache(cfg: AppConfig, projectId: string, pdfHash: string): Promise<number> {
  const paths = new CachePaths(cfg);
  const manifest = await readJsonIfExists<ProjectManifest>(path.join(paths.output(projectId), 'manifest.json'));
  const others = await referencedElsewhere(cfg, projectId);
  const targets = [paths.work(projectId)];
  if (!others.pdfHashes.has(pdfHash)) targets.push(paths.pdfRoot(pdfHash), paths.pages(pdfHash), path.join(cfg.storage.renders, 'preview', pdfHash));
  const own = manifestKeys(manifest);
  const entries: string[] = [];
  for (const k of new Set(own.audio)) {
    if (others.audio.has(k)) continue;
    const f = paths.chapterAudio(k);
    entries.push(f.audio, f.meta);
  }
  for (const k of new Set(own.video)) if (!others.video.has(k)) entries.push(paths.videoSegment(k));
  let freed = 0;
  for (const t of [...targets, ...entries]) {
    freed += (await dirSize(t)) || (await fileSize(t));
    await rmrf(t);
  }
  for (const f of entries) freed += await removeTempSiblings(f);
  return freed;
}

/** Delete a project. Outputs are only removed when explicitly requested. */
export async function deleteProjectFiles(cfg: AppConfig, projectId: string, pdfHash: string, opts: { deleteOutputs: boolean; deleteUpload: boolean }): Promise<void> {
  const paths = new CachePaths(cfg);
  await cleanProjectCache(cfg, projectId, pdfHash);
  if (opts.deleteOutputs) await rmrf(paths.output(projectId));
  if (opts.deleteUpload) await rmrf(paths.upload(pdfHash));
}

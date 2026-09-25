import path from 'node:path';
import type { AppConfig } from '@app/config';
import { dirSize, readJsonIfExists, rmrf } from '@app/shared';
import { CachePaths, type ProjectManifest } from './pipeline/paths';

/**
 * "Clean project cache": remove intermediate/cached data for a project but NEVER the final
 * outputs (audiobook.mp4 / .m4a / subtitles.srt). Returns bytes freed.
 */
export async function cleanProjectCache(cfg: AppConfig, projectId: string, pdfHash: string): Promise<number> {
  const paths = new CachePaths(cfg);
  const manifest = await readJsonIfExists<ProjectManifest>(path.join(paths.output(projectId), 'manifest.json'));
  const targets = [paths.pdfRoot(pdfHash), paths.pages(pdfHash), path.join(cfg.storage.renders, 'preview', pdfHash), paths.work(projectId)];
  for (const k of manifest?.audioKeys ?? []) {
    const f = paths.chapterAudio(k);
    targets.push(f.audio, f.meta);
  }
  for (const k of manifest?.videoKeys ?? []) targets.push(paths.videoSegment(k));
  let freed = 0;
  for (const t of targets) {
    freed += await dirSize(t).then(async (n) => n || (await import('@app/shared')).fileSize(t));
    await rmrf(t);
  }
  return freed;
}

/** Delete a project. Outputs are only removed when explicitly requested. */
export async function deleteProjectFiles(cfg: AppConfig, projectId: string, pdfHash: string, opts: { deleteOutputs: boolean; deleteUpload: boolean }): Promise<void> {
  const paths = new CachePaths(cfg);
  await cleanProjectCache(cfg, projectId, pdfHash);
  if (opts.deleteOutputs) await rmrf(paths.output(projectId));
  if (opts.deleteUpload) await rmrf(paths.upload(pdfHash));
}

import path from 'node:path';
import type { AppConfig } from '@app/config';

/**
 * Content-addressed cache layout. Keys are hashes of (inputs + settings that matter for
 * that stage), so changing the video theme never invalidates TTS, and changing the voice
 * never invalidates PDF extraction or LLM work.
 */
export class CachePaths {
  constructor(private readonly cfg: AppConfig) {}

  upload(pdfHash: string) {
    return path.join(this.cfg.storage.uploads, `${pdfHash}.pdf`);
  }
  pdfRoot(pdfHash: string) {
    return path.join(this.cfg.storage.extracted, pdfHash);
  }
  extraction(pdfHash: string, key: string) {
    return path.join(this.pdfRoot(pdfHash), `extract-${key}`);
  }
  analysis(pdfHash: string, key: string) {
    return path.join(this.pdfRoot(pdfHash), `analysis-${key}.json`);
  }
  llmCache() {
    return path.join(this.cfg.storage.extracted, 'llm-cache');
  }
  chapterAudio(key: string) {
    return { audio: path.join(this.cfg.storage.audio, `${key}.flac`), meta: path.join(this.cfg.storage.audio, `${key}.json`) };
  }
  pages(pdfHash: string) {
    return path.join(this.cfg.storage.renders, 'pages', pdfHash);
  }
  preview(pdfHash: string, page: number) {
    return path.join(this.cfg.storage.renders, 'preview', pdfHash, `page-${String(page).padStart(4, '0')}.jpg`);
  }
  videoSegment(key: string) {
    return path.join(this.cfg.storage.renders, 'video', `${key}.mp4`);
  }
  output(projectId: string) {
    return path.join(this.cfg.storage.output, projectId);
  }
  work(projectId: string) {
    return path.join(this.cfg.storage.output, projectId, '.work');
  }
}

export interface ProjectManifest {
  pdfHash: string;
  extractKey?: string;
  analysisKey?: string;
  audioKeys: string[];
  videoKeys: string[];
  masterKey?: string;
  timelineKey?: string;
  muxKey?: string;
  durationSec?: number;
}

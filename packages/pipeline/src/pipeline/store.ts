import path from 'node:path';
import type { Analysis, ChapterAudio, OutputFile, ProgressSnapshot, StepRecord, Timeline } from '@app/types';
import { atomicWriteJson, readJsonIfExists } from '@app/shared';

export type OutputRecord = Omit<OutputFile, 'url'> & { path: string };

/**
 * Where the pipeline persists progress and results. The API implements this with
 * PostgreSQL (Prisma); the CLI uses the JSON FileStore below. Resumability itself is
 * artifact-driven (content-addressed cache), so any store works.
 */
export interface PipelineStore {
  loadSteps(): Promise<StepRecord[]>;
  saveSteps(steps: StepRecord[]): Promise<void>;
  updateStep(step: StepRecord): Promise<void>;
  updateSnapshot(snapshot: ProgressSnapshot): Promise<void>;
  saveAnalysis(analysis: Analysis, analysisKey: string): Promise<void>;
  saveChapterAudio(audio: ChapterAudio): Promise<void>;
  saveTimeline(timeline: Timeline): Promise<void>;
  saveOutputs(outputs: OutputRecord[]): Promise<void>;
}

interface FileState {
  steps: StepRecord[];
  snapshot?: ProgressSnapshot;
  outputs: OutputRecord[];
  analysisKey?: string;
}

export class FileStore implements PipelineStore {
  private state: FileState = { steps: [], outputs: [] };
  private loaded = false;
  constructor(private readonly dir: string) {}

  private get file() {
    return path.join(this.dir, 'state.json');
  }

  private async load(): Promise<FileState> {
    if (!this.loaded) {
      this.state = (await readJsonIfExists<FileState>(this.file)) ?? { steps: [], outputs: [] };
      this.loaded = true;
    }
    return this.state;
  }

  private flush() {
    return atomicWriteJson(this.file, this.state, true);
  }

  async loadSteps() {
    return (await this.load()).steps;
  }
  async saveSteps(steps: StepRecord[]) {
    (await this.load()).steps = steps;
    await this.flush();
  }
  async updateStep(step: StepRecord) {
    const s = await this.load();
    const i = s.steps.findIndex((x) => x.key === step.key);
    if (i >= 0) s.steps[i] = step;
    else s.steps.push(step);
    await this.flush();
  }
  async updateSnapshot(snapshot: ProgressSnapshot) {
    (await this.load()).snapshot = snapshot;
    await this.flush();
  }
  async saveAnalysis(_a: Analysis, key: string) {
    (await this.load()).analysisKey = key;
    await this.flush();
  }
  async saveChapterAudio() {}
  async saveTimeline() {}
  async saveOutputs(outputs: OutputRecord[]) {
    (await this.load()).outputs = outputs;
    await this.flush();
  }
}

/** No-op store for tests. */
export class MemoryStore implements PipelineStore {
  steps: StepRecord[] = [];
  snapshots: ProgressSnapshot[] = [];
  outputs: OutputRecord[] = [];
  audios: ChapterAudio[] = [];
  async loadSteps() {
    return this.steps;
  }
  async saveSteps(s: StepRecord[]) {
    this.steps = s;
  }
  async updateStep(step: StepRecord) {
    const i = this.steps.findIndex((x) => x.key === step.key);
    if (i >= 0) this.steps[i] = step;
    else this.steps.push(step);
  }
  async updateSnapshot(s: ProgressSnapshot) {
    this.snapshots.push(s);
  }
  async saveAnalysis() {}
  async saveChapterAudio(a: ChapterAudio) {
    this.audios.push(a);
  }
  async saveTimeline() {}
  async saveOutputs(o: OutputRecord[]) {
    this.outputs = o;
  }
}

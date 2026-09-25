import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@app/config';
import { AppError, CancelledError, atomicWrite, ensureDir } from '@app/shared';

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  /** progress in seconds of output written */
  onTime?: (sec: number) => void;
}

export function run(bin: string, args: string[], opts: FfmpegRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      const s = String(d);
      err = (err + s).slice(-8000);
      if (opts.onTime) {
        const m = /out_time_ms=(\d+)/.exec(s) ?? /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (m) opts.onTime(m.length === 2 ? Number(m[1]) / 1e6 : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    const onAbort = () => p.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new AppError('FFMPEG_MISSING', 'FFmpeg is not installed.', { hint: 'Install it with: brew install ffmpeg', cause: e }));
    });
    p.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new CancelledError());
      if (code === 0) resolve(out);
      else reject(new AppError('FFMPEG_FAILED', 'FFmpeg could not process the media files.', { details: { args, stderr: err.slice(-3000) } }));
    });
  });
}

export interface ProbeResult {
  duration: number;
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; duration?: string; nb_frames?: string }[];
}

export async function probe(cfg: AppConfig, file: string): Promise<ProbeResult> {
  const out = await run(cfg.FFPROBE_BIN, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,duration,nb_frames', '-of', 'json', file]);
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: ProbeResult['streams'] };
  return { duration: Number(j.format?.duration ?? 0), streams: j.streams ?? [] };
}

const encoderCache = new Map<string, Set<string>>();
export async function ffmpegEncoders(cfg: AppConfig): Promise<Set<string>> {
  const hit = encoderCache.get(cfg.FFMPEG_BIN);
  if (hit) return hit;
  const out = await run(cfg.FFMPEG_BIN, ['-hide_banner', '-encoders']);
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (m) set.add(m[1]);
  }
  encoderCache.set(cfg.FFMPEG_BIN, set);
  return set;
}

export async function pickAudioEncoder(cfg: AppConfig): Promise<string> {
  if (cfg.AUDIO_ENCODER !== 'auto') return cfg.AUDIO_ENCODER;
  const enc = await ffmpegEncoders(cfg);
  return enc.has('aac_at') ? 'aac_at' : 'aac'; // aac_at = Apple AudioToolbox (hardware-tuned, high quality)
}

const listLine = (f: string) => `file '${f.replace(/'/g, "'\\''")}'`;

export async function writeConcatList(file: string, inputs: string[]): Promise<string> {
  await atomicWrite(file, inputs.map(listLine).join('\n') + '\n');
  return file;
}

export interface ChapterMark {
  title: string;
  start: number;
  end: number;
}

export function ffmetadata(title: string, chapters: ChapterMark[]): string {
  const esc = (s: string) => s.replace(/([=;#\\\n])/g, '\\$1');
  let s = `;FFMETADATA1\ntitle=${esc(title)}\n`;
  for (const c of chapters) {
    s += `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${esc(c.title)}\n`;
  }
  return s;
}

/** Concatenate chapter FLACs → AAC .m4a (loudness-normalized for YouTube, with chapter markers). */
export async function masterAudio(
  cfg: AppConfig,
  inputs: string[],
  outFile: string,
  o: { normalize: boolean; title: string; chapters: ChapterMark[]; workDir: string; signal?: AbortSignal; onTime?: (s: number) => void },
): Promise<void> {
  await ensureDir(o.workDir);
  const list = await writeConcatList(path.join(o.workDir, 'audio-concat.txt'), inputs);
  const meta = path.join(o.workDir, 'audio-meta.txt');
  await atomicWrite(meta, ffmetadata(o.title, o.chapters));
  const codec = await pickAudioEncoder(cfg);
  const tmp = `${outFile}.tmp.m4a`;
  const filters = [o.normalize ? 'loudnorm=I=-16:TP=-1.5:LRA=11' : null, 'aresample=48000'].filter(Boolean).join(',');
  await run(
    cfg.FFMPEG_BIN,
    ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:2', '-f', 'concat', '-safe', '0', '-i', list, '-i', meta,
      '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-af', filters, '-ac', '1',
      '-c:a', codec, '-b:a', cfg.AUDIO_BITRATE, '-movflags', '+faststart', tmp],
    { signal: o.signal, onTime: o.onTime },
  );
  await fsp.rename(tmp, outFile);
}

/** Concatenate chapter video segments (stream copy) + mastered audio (+ soft subtitles) → final MP4. */
export async function muxFinal(
  cfg: AppConfig,
  videos: string[],
  audio: string,
  outFile: string,
  o: { srt?: string; title: string; chapters: ChapterMark[]; workDir: string; language: string; signal?: AbortSignal },
): Promise<void> {
  await ensureDir(o.workDir);
  const list = await writeConcatList(path.join(o.workDir, 'video-concat.txt'), videos);
  const meta = path.join(o.workDir, 'video-meta.txt');
  await atomicWrite(meta, ffmetadata(o.title, o.chapters));
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio];
  if (o.srt) args.push('-i', o.srt);
  args.push('-i', meta);
  const metaIdx = o.srt ? 3 : 2;
  args.push('-map', '0:v:0', '-map', '1:a:0');
  if (o.srt) args.push('-map', '2:s:0', '-c:s', 'mov_text', '-metadata:s:s:0', `language=${o.language === 'bn' ? 'ben' : 'eng'}`);
  args.push('-map_metadata', String(metaIdx), '-map_chapters', String(metaIdx), '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart');
  const tmp = `${outFile}.tmp.mp4`;
  args.push(tmp);
  await run(cfg.FFMPEG_BIN, args, { signal: o.signal });
  await fsp.rename(tmp, outFile);
}

/** Verify the final file: has video + audio and both tracks have the same length. */
export async function validateOutput(cfg: AppConfig, file: string, expectedDuration: number, fps: number): Promise<{ duration: number; drift: number }> {
  const p = await probe(cfg, file);
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  if (!v || !a) throw new AppError('OUTPUT_INVALID', 'The final video is missing its picture or sound track.', { details: p });
  const vd = Number(v.duration ?? p.duration);
  const ad = Number(a.duration ?? p.duration);
  const drift = Math.abs(vd - ad);
  const tolerance = 2 / fps + 0.1;
  if (drift > tolerance || Math.abs(ad - expectedDuration) > 0.5)
    throw new AppError('OUTPUT_OUT_OF_SYNC', 'The final video failed the audio/video sync check.', { details: { vd, ad, expectedDuration } });
  return { duration: p.duration, drift };
}

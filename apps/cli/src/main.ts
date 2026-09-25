#!/usr/bin/env node
/**
 * CLI for the full pipeline — no web UI, database or Redis needed.
 *
 *   pnpm audiobook ./book.pdf
 *   pnpm audiobook ./book.pdf --voice am_michael --chapters 1-2 --out ./output
 *   node apps/cli/dist/main.js doctor | voices | inspect <pdf> | sample <out.pdf>
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '@app/config';
import {
  FileStore,
  PipelineRunner,
  PythonPool,
  PythonProcess,
  checkLocalEnvironment,
  createTTSProvider,
} from '@app/pipeline';
import { createLogger, describeError, formatBytes, formatDuration, sha256File, toAppError } from '@app/shared';
import {
  ASPECT_SIZES,
  STAGE_LABELS,
  resolveSettings,
  type AspectRatio,
  type DeepPartial,
  type PdfInspection,
  type ProgressSnapshot,
  type ProjectSettings,
  type StepRecord,
} from '@app/types';

const cwd = process.env.INIT_CWD || process.cwd();
const resolveArg = (p: string) => path.resolve(cwd, p);
const tty = process.stdout.isTTY;

const HELP = `
Usage:
  audiobook create <book.pdf> [options]     Generate audiobook.mp4 / audiobook.m4a / subtitles.srt
  audiobook inspect <book.pdf>              Page count, word estimate, scan detection
  audiobook voices [--engine kokoro]        List installed voices
  audiobook doctor                          Check local dependencies
  audiobook sample <out.pdf>                Write a small sample book PDF for testing

Options for create:
  --out <dir>               Output folder (default: ./output)
  --mode video|audio        Audiobook + animated PDF (default) or audio only
  --engine kokoro|piper|say TTS engine (default from .env)
  --voice <id>              Voice id (e.g. af_heart, am_michael, bf_emma)
  --speed <n>               Speech speed 0.5–2.0 (default 1.0)
  --aspect 16:9|9:16|1:1    Video format (default 16:9)
  --fps <n>                 Frames per second (default 30)
  --animation follow|kenburns|static
  --highlight sentence|paragraph
  --highlight-style marker|underline|box
  --theme paper|light|dark
  --chapters <a-b>          Only chapters a..b (1-based), e.g. 1-2
  --skip-front-matter       Skip content before the first chapter
  --no-llm                  Do not use the local LLM (Ollama)
  --ocr auto|off|force      OCR for scanned pages (needs tesseract)
  --password <pw>           Password for protected PDFs
  --force                   Ignore caches and redo everything
  --verbose                 Developer logs
`;

function bar(p: number, width = 24): string {
  const n = Math.round((p / 100) * width);
  return `${'█'.repeat(n)}${'░'.repeat(width - n)}`;
}

function progressPrinter() {
  let last = '';
  const printed = new Set<string>();
  const clear = () => tty && process.stdout.write('\r\x1b[2K');
  return {
    update(s: ProgressSnapshot, steps: StepRecord[]) {
      for (const st of steps) {
        const id = `${st.key}:${st.status}`;
        if ((st.status === 'COMPLETED' || st.status === 'FAILED' || st.status === 'SKIPPED') && !printed.has(id)) {
          printed.add(id);
          clear();
          const mark = st.status === 'COMPLETED' ? '✓' : st.status === 'SKIPPED' ? '–' : '✗';
          const label = st.key.startsWith('TTS_CHAPTER_') || st.key.startsWith('VIDEO_CHAPTER_') ? st.key.replace(/_/g, ' ').toLowerCase() : STAGE_LABELS[st.stage];
          console.log(`  ${mark} ${label.padEnd(22)} ${st.cached ? '(cached) ' : ''}${st.message ?? st.error?.message ?? ''}`);
          last = '';
        }
      }
      const ch = s.currentChapter && s.totalChapters ? ` · chapter ${s.currentChapter}/${s.totalChapters}` : '';
      const line = `  ${bar(s.progress)} ${s.progress.toFixed(1).padStart(5)}%  ${s.status}${ch}  ${(s.message ?? '').slice(0, 70)}`;
      if (tty && line !== last) {
        process.stdout.write(`\r\x1b[2K${line}`);
        last = line;
      }
    },
    done() {
      clear();
    },
  };
}

async function linkOrCopy(src: string, dst: string) {
  await fsp.rm(dst, { force: true });
  try {
    await fsp.link(src, dst);
  } catch {
    await fsp.copyFile(src, dst);
  }
}

async function cmdCreate(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      mode: { type: 'string' },
      engine: { type: 'string' },
      voice: { type: 'string' },
      speed: { type: 'string' },
      aspect: { type: 'string' },
      fps: { type: 'string' },
      animation: { type: 'string' },
      highlight: { type: 'string' },
      'highlight-style': { type: 'string' },
      theme: { type: 'string' },
      chapters: { type: 'string' },
      'skip-front-matter': { type: 'boolean' },
      'no-llm': { type: 'boolean' },
      ocr: { type: 'string' },
      password: { type: 'string' },
      force: { type: 'boolean' },
      verbose: { type: 'boolean' },
    },
  });
  const file = positionals[0];
  if (!file) throw new Error('Missing PDF path. Usage: pnpm audiobook ./book.pdf');
  const pdfPath = resolveArg(file);
  if (!fs.existsSync(pdfPath)) throw new Error(`File not found: ${pdfPath}`);

  const cfg = loadConfig();
  const log = createLogger('cli', values.verbose ? 'debug' : 'warn');
  const engine = (values.engine ?? cfg.TTS_ENGINE) as ProjectSettings['tts']['engine'];
  const partial: DeepPartial<ProjectSettings> = {
    outputMode: values.mode === 'audio' ? 'audiobook_only' : 'audiobook_video',
    tts: {
      engine,
      voice: values.voice ?? (engine === cfg.TTS_ENGINE ? cfg.TTS_DEFAULT_VOICE : (await import('@app/pipeline')).DEFAULT_VOICES[engine]),
      speed: values.speed ? Number(values.speed) : 1,
    },
    text: {
      useLlm: !values['no-llm'],
      skipFrontMatter: !!values['skip-front-matter'],
      ocr: (values.ocr as 'auto') ?? 'auto',
    },
    video: {
      fps: values.fps ? Number(values.fps) : cfg.VIDEO_FPS,
      ...(values.aspect ? { aspectRatio: values.aspect as AspectRatio, ...ASPECT_SIZES[values.aspect as AspectRatio] } : {}),
      ...(values.animation ? { animation: values.animation as 'follow' } : {}),
      ...(values.highlight ? { highlightMode: values.highlight as 'sentence' } : {}),
      ...(values['highlight-style'] ? { highlightStyle: values['highlight-style'] as 'marker' } : {}),
      ...(values.theme ? { theme: values.theme as 'paper' } : {}),
    },
  };
  if (values.aspect && !ASPECT_SIZES[values.aspect as AspectRatio]) throw new Error(`Unsupported aspect ratio: ${values.aspect}`);
  if (values.chapters) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(values.chapters);
    if (!m) throw new Error('--chapters must look like 3 or 1-4');
    partial.text!.chapterRange = { from: Number(m[1]), to: Number(m[2] ?? m[1]) };
  }
  const settings = resolveSettings(partial);

  console.log(`\n📖  ${path.basename(pdfPath)}  (${formatBytes(fs.statSync(pdfPath).size)})`);
  const pdfHash = await sha256File(pdfPath);
  const projectId = `cli-${pdfHash.slice(0, 16)}`;
  const outDir = values.out ? resolveArg(values.out) : path.join(cwd, 'output');
  const store = new FileStore(path.join(cfg.storage.output, projectId));
  const printer = progressPrinter();
  const controller = new AbortController();
  process.once('SIGINT', () => {
    printer.done();
    console.log('\n  Stopping… (progress is saved; run the same command to resume)');
    controller.abort();
  });

  console.log(`    voice ${settings.tts.engine}/${settings.tts.voice} · ${settings.outputMode === 'audiobook_video' ? `${settings.video.width}x${settings.video.height}@${settings.video.fps} ${settings.video.animation}` : 'audio only'}\n`);
  const started = Date.now();
  const runner = new PipelineRunner(cfg, store, log, { onSnapshot: (s, steps) => printer.update(s, steps) });
  const result = await runner.run(
    { projectId, pdfPath, pdfHash, title: path.basename(pdfPath, path.extname(pdfPath)), settings, password: values.password },
    { force: values.force, signal: controller.signal },
  );
  printer.done();

  await fsp.mkdir(outDir, { recursive: true });
  for (const o of result.outputs) if (o.name !== 'timeline.json') await linkOrCopy(o.path, path.join(outDir, o.name));
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  console.log(`\n✅  Done in ${formatDuration((Date.now() - started) / 1000)} — narration length ${formatDuration(result.durationSec)}`);
  console.log(`    ${outDir}/`);
  for (const o of result.outputs) if (o.name !== 'timeline.json') console.log(`      ${o.name.padEnd(16)} ${formatBytes(o.size)}`);
  console.log('');
}

async function cmdDoctor() {
  const cfg = loadConfig();
  console.log('\nChecking local environment…\n');
  const checks = await checkLocalEnvironment(cfg);
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : c.required ? '✗' : '!'} ${c.name.padEnd(34)} ${c.message}`);
    if (!c.ok && c.fix) console.log(`      fix: ${c.fix}`);
  }
  const bad = checks.filter((c) => c.required && !c.ok);
  console.log(bad.length ? `\n${bad.length} required check(s) failed.\n` : '\nAll required checks passed.\n');
  process.exitCode = bad.length ? 1 : 0;
}

async function cmdVoices(args: string[]) {
  const { values } = parseArgs({ args, options: { engine: { type: 'string' } } });
  const cfg = loadConfig();
  const pool = new PythonPool(cfg, 1);
  try {
    const provider = createTTSProvider(values.engine ?? cfg.TTS_ENGINE, pool);
    const st = await provider.isAvailable();
    if (!st.ok) {
      console.log(`${provider.engine}: ${st.message}`);
      return;
    }
    for (const v of await provider.listVoices()) console.log(`  ${v.id.padEnd(24)} ${v.language.padEnd(6)} ${v.gender ?? ''}`);
  } finally {
    await pool.shutdown();
  }
}

async function cmdInspect(args: string[]) {
  const cfg = loadConfig();
  const py = new PythonProcess(cfg);
  try {
    const info = await py.call<PdfInspection>('pdf.inspect', { path: resolveArg(args[0]) });
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await py.stop();
  }
}

async function cmdSample(args: string[]) {
  const cfg = loadConfig();
  const out = resolveArg(args[0] ?? 'sample-book.pdf');
  const { execFileSync } = await import('node:child_process');
  execFileSync(cfg.PYTHON_BIN, ['-m', 'audiobook_worker.sample', out, ...args.slice(1)], {
    env: { ...process.env, PYTHONPATH: cfg.workerDir },
    stdio: 'inherit',
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'create':
      return cmdCreate(rest);
    case 'doctor':
      return cmdDoctor();
    case 'voices':
      return cmdVoices(rest);
    case 'inspect':
      return cmdInspect(rest);
    case 'sample':
      return cmdSample(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      // `pnpm audiobook ./book.pdf` → treat a bare path as `create`
      if (cmd.toLowerCase().endsWith('.pdf')) return cmdCreate([cmd, ...rest]);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const e = toAppError(err, (err as Error)?.message);
  process.stdout.write('\n');
  console.error(`\n❌  ${e.message}`);
  if (e.hint) console.error(`    ${e.hint}`);
  if (process.argv.includes('--verbose')) console.error(describeError(err));
  else console.error('    (run with --verbose for technical details)');
  process.exitCode = 1;
});

import type { AppConfig } from '@app/config';
import type { HealthCheck } from '@app/types';
import { formatBytes, freeDiskBytes } from '@app/shared';
import { ffmpegEncoders, run } from './audio/ffmpeg';
import { OllamaProvider } from './llm/ollama';
import { PythonProcess } from './python/bridge';

interface PySystemInfo {
  python: string;
  pymupdf: string;
  tesseract: boolean;
  tts: Record<string, { available: boolean; message: string }>;
}

/** Local environment checks with exact fix commands. Used by `pnpm doctor` and GET /system/health. */
export async function checkLocalEnvironment(cfg: AppConfig): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  // Python worker + engines
  const py = new PythonProcess(cfg);
  try {
    const info = await py.call<PySystemInfo>('system.info', {}, { timeoutMs: 30_000 });
    checks.push({ name: 'Python worker', ok: true, required: true, message: `Python ${info.python}, PyMuPDF ${info.pymupdf}` });
    const engine = info.tts[cfg.TTS_ENGINE];
    checks.push({
      name: `TTS engine (${cfg.TTS_ENGINE})`,
      ok: !!engine?.available,
      required: true,
      message: engine?.message ?? 'unknown',
      fix: engine?.available ? undefined : cfg.TTS_ENGINE === 'kokoro' ? 'pnpm setup:models' : engine?.message,
    });
    for (const [name, st] of Object.entries(info.tts))
      if (name !== cfg.TTS_ENGINE) checks.push({ name: `TTS engine (${name})`, ok: st.available, required: false, message: st.message });
    checks.push({
      name: 'OCR (Tesseract)',
      ok: info.tesseract,
      required: false,
      message: info.tesseract ? 'available for scanned PDFs' : 'not installed — scanned PDFs cannot be read',
      fix: info.tesseract ? undefined : 'brew install tesseract',
    });
  } catch (e) {
    checks.push({ name: 'Python worker', ok: false, required: true, message: (e as Error).message, fix: 'pnpm setup:python' });
  } finally {
    await py.stop();
  }

  // FFmpeg
  try {
    const v = (await run(cfg.FFMPEG_BIN, ['-version'])).split('\n')[0];
    const enc = await ffmpegEncoders(cfg);
    const vt = enc.has('h264_videotoolbox');
    checks.push({ name: 'FFmpeg', ok: true, required: true, message: v.replace(/ Copyright.*/, '') });
    checks.push({
      name: 'VideoToolbox (hardware H.264)',
      ok: vt,
      required: false,
      message: vt ? 'available — fast, low-CPU encoding' : 'not available, will use libx264 (slower)',
    });
  } catch {
    checks.push({ name: 'FFmpeg', ok: false, required: true, message: 'not installed', fix: 'brew install ffmpeg' });
  }

  // Ollama
  if (cfg.LLM_ENABLED) {
    const st = await new OllamaProvider({ baseUrl: cfg.OLLAMA_BASE_URL, model: cfg.OLLAMA_MODEL, timeoutMs: 5000 }).isAvailable();
    checks.push({
      name: `Local LLM (Ollama ${cfg.OLLAMA_MODEL})`,
      ok: st.ok,
      required: false,
      message: st.ok ? 'ready' : `${st.message} (optional — rules are used without it)`,
      fix: st.ok ? undefined : st.message.includes('pull') ? `ollama pull ${cfg.OLLAMA_MODEL}` : 'brew install ollama && ollama serve',
    });
  }

  // Disk
  try {
    const free = await freeDiskBytes(cfg.storage.root);
    const ok = free > cfg.DISK_RESERVE_GB * 1e9 + 10e9;
    checks.push({
      name: 'Disk space',
      ok,
      required: false,
      message: `${formatBytes(free)} free${ok ? '' : ' — a 280-page book needs ~6–10 GB while processing'}`,
    });
  } catch {
    /* ignore */
  }
  return checks;
}

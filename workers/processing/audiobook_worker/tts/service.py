"""TTS RPC methods. Chapter synthesis streams to a FLAC file — the chapter never sits in RAM."""
from __future__ import annotations

import os
import time

import numpy as np
import soundfile as sf

from ..errors import WorkerError
from ..util import atomic_path
from .base import resample, to_float_mono, trim_silence
from .registry import ENGINES, engine_status, get_engine

MAX_RETRIES = 2


def engines_rpc(params: dict, ctx) -> dict:
    return engine_status()


def voices_rpc(params: dict, ctx) -> dict:
    name = params.get("engine", "kokoro")
    ok, msg = ENGINES[name].available() if name in ENGINES else (False, "unknown engine")
    if not ok:
        return {"engine": name, "available": False, "message": msg, "voices": []}
    eng = get_engine(name)
    return {"engine": name, "available": True, "voices": [v.__dict__ for v in eng.voices()]}


def _synth(engine, text: str, voice: str, speed: float, language: str, rate: int) -> np.ndarray:
    last: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            audio, src_rate = engine.synthesize(text, voice, speed, language)
            audio = resample(to_float_mono(audio), int(src_rate), rate)
            return trim_silence(audio, rate)
        except WorkerError as e:
            if not e.retryable:
                raise
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(0.2 * (attempt + 1))
    raise WorkerError("TTS_FAILED", f"Speech synthesis failed: {last}", {"text": text[:200]}, retryable=True)


def synthesize_rpc(params: dict, ctx) -> dict:
    """Single utterance → WAV file. Used by TTSProvider.synthesize()."""
    rate = int(params.get("sampleRate", 24000))
    engine = get_engine(params.get("engine", "kokoro"))
    audio = _synth(engine, params["text"], params["voice"], float(params.get("speed", 1.0)), params.get("language", "en"), rate)
    out = params["outPath"]
    with atomic_path(out) as tmp:
        sf.write(tmp, audio, rate, format="WAV", subtype="PCM_16")
    return {"path": out, "sampleRate": rate, "samples": int(audio.size), "duration": audio.size / rate}


def _word_timings(text: str, start: float, end: float) -> list[dict]:
    """Fallback word timestamps: distribute the sentence duration by word length (+1 for the gap)."""
    words = text.split()
    if not words:
        return []
    weights = np.array([len(w) + 1 for w in words], dtype=np.float64)
    edges = np.concatenate([[0.0], np.cumsum(weights) / weights.sum()])
    dur = end - start
    return [{"t": w, "start": round(start + edges[i] * dur, 3), "end": round(start + edges[i + 1] * dur, 3)}
            for i, w in enumerate(words)]


def synthesize_chapter(segments: list[dict], out_path: str, engine_name: str, voice: str, speed: float = 1.0,
                       language: str = "en", sample_rate: int = 24000, lead_in_ms: int = 0,
                       word_timings: bool = False, ctx=None) -> dict:
    """segments: [{id, text, pauseMs}] → FLAC with exact per-segment timings (sample accurate)."""
    engine = get_engine(engine_name)
    timings = []
    pos = 0
    rate = sample_rate
    with atomic_path(out_path) as tmp:
        with sf.SoundFile(tmp, mode="w", samplerate=rate, channels=1, format="FLAC", subtype="PCM_16") as f:
            if lead_in_ms > 0:
                n = int(rate * lead_in_ms / 1000)
                f.write(np.zeros(n, dtype=np.float32))
                pos += n
            for i, seg in enumerate(segments):
                text = (seg.get("text") or "").strip()
                audio = _synth(engine, text, voice, speed, language, rate) if text else np.zeros(0, dtype=np.float32)
                start = pos / rate
                if audio.size:
                    peak = float(np.max(np.abs(audio)))
                    if peak > 0.99:
                        audio = audio * (0.99 / peak)
                    f.write(audio)
                    pos += audio.size
                end = pos / rate
                t = {"id": seg["id"], "start": round(start, 4), "end": round(end, 4)}
                if word_timings:
                    t["words"] = _word_timings(text, start, end)
                timings.append(t)
                pause = int(rate * int(seg.get("pauseMs", 0)) / 1000)
                if pause > 0:
                    f.write(np.zeros(pause, dtype=np.float32))
                    pos += pause
                if ctx:
                    ctx.progress(i + 1, len(segments), None)
    return {"path": out_path, "sampleRate": rate, "samples": pos, "duration": pos / rate, "timings": timings}


def synthesize_chapter_rpc(params: dict, ctx) -> dict:
    return synthesize_chapter(
        params["segments"], params["outPath"], params.get("engine", "kokoro"), params["voice"],
        float(params.get("speed", 1.0)), params.get("language", "en"), int(params.get("sampleRate", 24000)),
        int(params.get("leadInMs", 0)), bool(params.get("wordTimings", False)), ctx,
    )

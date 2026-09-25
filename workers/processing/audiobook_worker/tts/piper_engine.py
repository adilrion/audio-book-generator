"""Piper (piper-tts) — very fast, lightweight VITS voices. Voices are .onnx + .onnx.json files in PIPER_MODEL_DIR."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from ..errors import WorkerError
from .base import TTSEngine, Voice


def _model_dir() -> Path:
    return Path(os.environ.get("PIPER_MODEL_DIR", "storage/models/piper"))


class PiperEngine(TTSEngine):
    name = "piper"

    def __init__(self) -> None:
        ok, msg = self.available()
        if not ok:
            raise WorkerError("TTS_ENGINE_UNAVAILABLE", msg)
        self._loaded: dict[str, object] = {}

    @classmethod
    def available(cls) -> tuple[bool, str]:
        try:
            import piper  # noqa: F401
        except ImportError:
            return False, "piper-tts is not installed. Run: workers/processing/.venv/bin/pip install piper-tts"
        if not any(_model_dir().glob("*.onnx")):
            return False, f"No Piper voices found in {_model_dir()}. Run: bash scripts/download-models.sh piper"
        return True, "ready"

    def voices(self) -> list[Voice]:
        out = []
        for f in sorted(_model_dir().glob("*.onnx")):
            vid = f.stem  # e.g. en_US-lessac-medium
            lang = vid.split("_", 1)[0]
            out.append(Voice(id=vid, name=vid.split("-")[1].capitalize() if "-" in vid else vid, language=lang))
        return out

    def _voice(self, voice_id: str):
        if voice_id not in self._loaded:
            from piper import PiperVoice

            path = _model_dir() / f"{voice_id}.onnx"
            if not path.exists():
                raise WorkerError("TTS_VOICE_NOT_FOUND", f"Piper voice not found: {voice_id}")
            self._loaded[voice_id] = PiperVoice.load(str(path))
        return self._loaded[voice_id]

    def synthesize(self, text: str, voice: str, speed: float, language: str) -> tuple[np.ndarray, int]:
        v = self._voice(voice)
        rate = int(v.config.sample_rate)
        chunks: list[bytes] = []
        if hasattr(v, "synthesize_stream_raw"):  # piper-tts <= 1.2
            for b in v.synthesize_stream_raw(text, length_scale=1.0 / max(0.25, speed)):
                chunks.append(b)
        else:  # piper-tts >= 1.3
            from piper import SynthesisConfig

            cfg = SynthesisConfig(length_scale=1.0 / max(0.25, speed))
            for chunk in v.synthesize(text, syn_config=cfg):
                chunks.append(chunk.audio_int16_bytes)
        audio = np.frombuffer(b"".join(chunks), dtype=np.int16).astype(np.float32) / 32768.0
        return audio, rate

"""Kokoro-82M via ONNX Runtime (kokoro-onnx). Runs well on Apple Silicon CPU (~5x realtime on M4)."""
from __future__ import annotations

import os

import numpy as np

from ..errors import WorkerError
from .base import TTSEngine, Voice

_LANG_BY_PREFIX = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}
_LANG_NAMES = {"a": "en", "b": "en", "e": "es", "f": "fr", "h": "hi", "i": "it", "j": "ja", "p": "pt", "z": "zh"}


def _paths() -> tuple[str, str]:
    return (os.environ.get("KOKORO_MODEL_PATH", "storage/models/kokoro/kokoro-v1.0.onnx"),
            os.environ.get("KOKORO_VOICES_PATH", "storage/models/kokoro/voices-v1.0.bin"))


class KokoroEngine(TTSEngine):
    name = "kokoro"

    def __init__(self) -> None:
        ok, msg = self.available()
        if not ok:
            raise WorkerError("TTS_ENGINE_UNAVAILABLE", msg)
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        model, voices = _paths()
        so = ort.SessionOptions()
        threads = int(os.environ.get("KOKORO_THREADS", "0") or 0)
        if threads > 0:
            so.intra_op_num_threads = threads
        provider = os.environ.get("KOKORO_PROVIDER", "cpu").lower()
        providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"] if provider == "coreml" else ["CPUExecutionProvider"]
        session = ort.InferenceSession(model, sess_options=so, providers=providers)
        self._k = Kokoro.from_session(session, voices)

    @classmethod
    def available(cls) -> tuple[bool, str]:
        try:
            import kokoro_onnx  # noqa: F401
        except ImportError:
            return False, "kokoro-onnx is not installed. Run: workers/processing/.venv/bin/pip install kokoro-onnx"
        model, voices = _paths()
        if not os.path.exists(model) or not os.path.exists(voices):
            return False, "Kokoro model files are missing. Run: pnpm setup:models"
        return True, "ready"

    def voices(self) -> list[Voice]:
        out = []
        for v in sorted(self._k.get_voices()):
            prefix, gender = v[0], v[1] if len(v) > 1 else ""
            out.append(Voice(id=v, name=v.split("_", 1)[-1].capitalize(), language=_LANG_NAMES.get(prefix, "en"),
                             gender={"f": "female", "m": "male"}.get(gender)))
        return out

    def synthesize(self, text: str, voice: str, speed: float, language: str) -> tuple[np.ndarray, int]:
        lang = _LANG_BY_PREFIX.get(voice[:1], "en-us") if language in ("en", "", None) else language
        samples, rate = self._k.create(text, voice=voice, speed=float(speed), lang=lang, trim=True)
        return samples, rate

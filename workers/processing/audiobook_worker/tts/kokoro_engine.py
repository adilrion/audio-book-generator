"""Kokoro-82M via ONNX Runtime (kokoro-onnx). Runs well on Apple Silicon CPU (~5x realtime on M4)."""
from __future__ import annotations

import os

import numpy as np

from ..errors import WorkerError
from .base import TTSEngine, Voice

_LANG_BY_PREFIX = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}
_LANG_NAMES = {"a": "en", "b": "en", "e": "es", "f": "fr", "h": "hi", "i": "it", "j": "ja", "p": "pt", "z": "zh"}

# Voices made by mixing Kokoro's own (their style vectors, weighted). Ids follow Kokoro's scheme, so the
# language and gender come from the prefix like any other voice.
#   am_coach: Onyx's depth with Puck's expression — deep (about 95 Hz) yet rising and falling like a
#   person speaking to a room, where Onyx alone is deep but flat. Made for motivational Shorts.
BLENDS: dict[str, tuple[tuple[str, float], ...]] = {
    "am_coach": (("am_puck", 0.5), ("am_onyx", 0.5)),
}


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
            so.inter_op_num_threads = 1
        # onnxruntime threads busy-wait between operators by default: pure heat, no speed on M-series
        # (measured). KOKORO_SPIN=1 restores it.
        if os.environ.get("KOKORO_SPIN", "0") != "1":
            so.add_session_config_entry("session.intra_op.allow_spinning", "0")
            so.add_session_config_entry("session.inter_op.allow_spinning", "0")
        provider = os.environ.get("KOKORO_PROVIDER", "cpu").lower()
        providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"] if provider == "coreml" else ["CPUExecutionProvider"]
        session = ort.InferenceSession(model, sess_options=so, providers=providers)
        self._k = Kokoro.from_session(session, voices)
        self._styles: dict[str, np.ndarray] = {}

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
        own = set(self._k.get_voices())
        blends = [b for b, parts in BLENDS.items() if all(p in own for p, _ in parts)]
        out = []
        for v in sorted(own) + blends:
            prefix, gender = v[0], v[1] if len(v) > 1 else ""
            out.append(Voice(id=v, name=v.split("_", 1)[-1].capitalize(), language=_LANG_NAMES.get(prefix, "en"),
                             gender={"f": "female", "m": "male"}.get(gender)))
        return out

    def _voice(self, voice: str):
        """A Kokoro voice name, or the mixed style vector of a blend."""
        parts = BLENDS.get(voice)
        if not parts:
            return voice
        if voice not in self._styles:
            self._styles[voice] = sum(self._k.get_voice_style(p) * w for p, w in parts)
        return self._styles[voice]

    def synthesize(self, text: str, voice: str, speed: float, language: str) -> tuple[np.ndarray, int]:
        lang = _LANG_BY_PREFIX.get(voice[:1], "en-us") if language in ("en", "", None) else language
        samples, rate = self._k.create(text, voice=self._voice(voice), speed=float(speed), lang=lang, trim=True)
        return samples, rate

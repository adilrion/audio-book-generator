"""TTS engine registry. To add an engine: implement TTSEngine and register it in ENGINES."""
from __future__ import annotations

from .base import TTSEngine
from .kokoro_engine import KokoroEngine
from .piper_engine import PiperEngine
from .say_engine import SayEngine

ENGINES: dict[str, type[TTSEngine]] = {
    "kokoro": KokoroEngine,
    "piper": PiperEngine,
    "say": SayEngine,
}

_instances: dict[str, TTSEngine] = {}


def get_engine(name: str) -> TTSEngine:
    from ..errors import WorkerError

    if name not in ENGINES:
        raise WorkerError("TTS_ENGINE_UNKNOWN", f"Unknown TTS engine: {name}")
    if name not in _instances:
        _instances[name] = ENGINES[name]()
    return _instances[name]


def engine_status() -> dict:
    out = {}
    for name, cls in ENGINES.items():
        ok, msg = cls.available()
        out[name] = {"available": ok, "message": msg}
    return out

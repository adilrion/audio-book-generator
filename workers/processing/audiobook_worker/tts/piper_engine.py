"""Piper (piper-tts) — very fast, lightweight VITS voices. Voices are .onnx + .onnx.json files in PIPER_MODEL_DIR.

A multi-speaker model (e.g. the Bangla bn_BD-google-medium, 16 speakers) is listed as one voice per
speaker, with the id `<model>:<speaker>` ("bn_BD-google-medium:4811"). A plain `<model>` id uses the
model's default speaker.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

from ..errors import WorkerError
from .base import TTSEngine, Voice


def _model_dir() -> Path:
    return Path(os.environ.get("PIPER_MODEL_DIR", "storage/models/piper"))


# Models with more speakers than this (LibriTTS: 904) are listed with their default speaker only.
MAX_LISTED_SPEAKERS = 32

# Speakers whose gender is known. bn_BD-google-medium: measured median pitch of each speaker —
# 4811 and rm about 245 Hz, the other 14 between 137 and 188 Hz.
SPEAKER_GENDERS: dict[str, dict[str, str]] = {
    "bn_BD-google-medium": {"4811": "female", "rm": "female", "*": "male"},
}

# espeak-ng's Bangla rules drop the vowel after a letter written as consonant + nukta
# ("বাড়ি" → "bar."), which is how NFC spells ড় ঢ় য়. The single code points read correctly.
_BN_COMPOSE = (("ড়", "ড়"), ("ঢ়", "ঢ়"), ("য়", "য়"))


def espeak_friendly(text: str, espeak_voice: str) -> str:
    """Text as the model's espeak-ng phonemizer reads it best."""
    if espeak_voice.startswith("bn"):
        for decomposed, single in _BN_COMPOSE:
            text = text.replace(decomposed, single)
    return text


def _read_config(onnx: Path) -> dict:
    try:
        with open(f"{onnx}.json", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def split_voice_id(voice_id: str) -> tuple[str, str | None]:
    """`bn_BD-google-medium:4811` → ("bn_BD-google-medium", "4811"); a plain model id has no speaker."""
    model, sep, speaker = voice_id.partition(":")
    return model, (speaker if sep else None)


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
            return False, f"No Piper voices found in {_model_dir()}. Run: bash scripts/download-models.sh piper (or: bangla)"
        return True, "ready"

    def voices(self) -> list[Voice]:
        out = []
        for f in sorted(_model_dir().glob("*.onnx")):
            vid = f.stem  # e.g. en_US-lessac-medium
            cfg = _read_config(f)
            lang = (cfg.get("language") or {}).get("family") or vid.split("_", 1)[0]
            name = vid.split("-")[1].capitalize() if "-" in vid else vid
            speakers = cfg.get("speaker_id_map") or {}
            if 1 < len(speakers) <= MAX_LISTED_SPEAKERS:
                genders = SPEAKER_GENDERS.get(vid, {})
                for key, sid in sorted(speakers.items(), key=lambda kv: kv[1]):
                    out.append(Voice(id=f"{vid}:{key}", name=f"{name} {sid + 1}", language=lang,
                                     gender=genders.get(key, genders.get("*"))))
            else:
                out.append(Voice(id=vid, name=name, language=lang))
        return out

    def _voice(self, model_id: str):
        if model_id not in self._loaded:
            from piper import PiperVoice

            path = _model_dir() / f"{model_id}.onnx"
            if not path.exists():
                raise WorkerError("TTS_VOICE_NOT_FOUND", f"Piper voice not found: {model_id}")
            self._loaded[model_id] = PiperVoice.load(str(path))
        return self._loaded[model_id]

    def synthesize(self, text: str, voice: str, speed: float, language: str) -> tuple[np.ndarray, int]:
        model_id, speaker = split_voice_id(voice)
        v = self._voice(model_id)
        sid = None
        if speaker is not None:
            sid = (v.config.speaker_id_map or {}).get(speaker)
            if sid is None:
                raise WorkerError("TTS_VOICE_NOT_FOUND", f"Piper voice {model_id} has no speaker {speaker}")
        text = espeak_friendly(text, getattr(v.config, "espeak_voice", "") or "")
        rate = int(v.config.sample_rate)
        length_scale = 1.0 / max(0.25, speed)
        chunks: list[bytes] = []
        if hasattr(v, "synthesize_stream_raw"):  # piper-tts <= 1.2
            for b in v.synthesize_stream_raw(text, speaker_id=sid, length_scale=length_scale):
                chunks.append(b)
        else:  # piper-tts >= 1.3
            from piper import SynthesisConfig

            cfg = SynthesisConfig(speaker_id=sid, length_scale=length_scale)
            for chunk in v.synthesize(text, syn_config=cfg):
                chunks.append(chunk.audio_int16_bytes)
        audio = np.frombuffer(b"".join(chunks), dtype=np.int16).astype(np.float32) / 32768.0
        return audio, rate

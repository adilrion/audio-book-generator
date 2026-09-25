"""macOS built-in `say` voices. Zero-install fallback; quality depends on installed system voices."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

from ..errors import WorkerError
from .base import TTSEngine, Voice

_VOICE_LINE = re.compile(r"^(?P<name>.+?)\s{2,}(?P<locale>[a-z]{2}[_-][A-Z0-9]{2,3})\s+#")


class SayEngine(TTSEngine):
    name = "say"
    RATE = 24000

    def __init__(self) -> None:
        ok, msg = self.available()
        if not ok:
            raise WorkerError("TTS_ENGINE_UNAVAILABLE", msg)

    @classmethod
    def available(cls) -> tuple[bool, str]:
        if sys.platform != "darwin":
            return False, "The 'say' engine is only available on macOS."
        return True, "ready"

    def voices(self) -> list[Voice]:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, check=False).stdout
        voices = []
        for line in out.splitlines():
            m = _VOICE_LINE.match(line)
            if m:
                name = m.group("name").strip()
                voices.append(Voice(id=name, name=name, language=m.group("locale")[:2]))
        return voices

    def synthesize(self, text: str, voice: str, speed: float, language: str) -> tuple[np.ndarray, int]:
        with tempfile.TemporaryDirectory() as d:
            txt, wav = os.path.join(d, "in.txt"), os.path.join(d, "out.wav")
            with open(txt, "w", encoding="utf-8") as fh:
                fh.write(text)
            cmd = ["say", "-r", str(int(185 * speed)), "-o", wav, "--file-format=WAVE",
                   f"--data-format=LEI16@{self.RATE}", "-f", txt]
            if voice and voice != "default":
                cmd[1:1] = ["-v", voice]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if proc.returncode != 0:
                raise WorkerError("TTS_FAILED", "macOS speech synthesis failed", {"stderr": proc.stderr[-500:]}, retryable=True)
            audio, rate = sf.read(wav, dtype="float32", always_2d=False)
            return audio, rate

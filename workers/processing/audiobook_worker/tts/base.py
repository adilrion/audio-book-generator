from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np


@dataclass
class Voice:
    id: str
    name: str
    language: str
    gender: str | None = None


class TTSEngine(ABC):
    """A local TTS engine. Implementations must be safe to call repeatedly in one process
    (models are loaded once and reused)."""

    name: str = "base"

    @classmethod
    @abstractmethod
    def available(cls) -> tuple[bool, str]:
        """(ok, message) — message explains how to install when not ok."""

    @abstractmethod
    def voices(self) -> list[Voice]:
        ...

    @abstractmethod
    def synthesize(self, text: str, voice: str, speed: float, language: str) -> tuple[np.ndarray, int]:
        """Return mono float32 samples in [-1, 1] and their sample rate."""


def to_float_mono(samples: np.ndarray) -> np.ndarray:
    a = np.asarray(samples)
    if a.dtype == np.int16:
        a = a.astype(np.float32) / 32768.0
    else:
        a = a.astype(np.float32, copy=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    return a


def resample(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or samples.size == 0:
        return samples
    import soxr

    return soxr.resample(samples, src_rate, dst_rate, quality="HQ").astype(np.float32, copy=False)


def trim_silence(samples: np.ndarray, rate: int, threshold_db: float = -48.0, pad_ms: int = 25) -> np.ndarray:
    """Trim leading/trailing silence so the orchestrator controls pauses precisely."""
    if samples.size == 0:
        return samples
    win = max(1, int(rate * 0.01))
    n = samples.size // win
    if n == 0:
        return samples
    frames = samples[: n * win].reshape(n, win)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    thr = 10 ** (threshold_db / 20)
    voiced = np.nonzero(rms > thr)[0]
    if voiced.size == 0:
        return samples[:0]
    pad = int(rate * pad_ms / 1000)
    start = max(0, voiced[0] * win - pad)
    end = min(samples.size, (voiced[-1] + 1) * win + pad)
    return samples[start:end]

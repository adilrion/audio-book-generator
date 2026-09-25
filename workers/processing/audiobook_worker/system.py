from __future__ import annotations

import platform
import sys

from . import VERSION


def info(params: dict, ctx) -> dict:
    import pymupdf as fitz

    tesseract = False
    try:
        fitz.get_tessdata()
        tesseract = True
    except Exception:  # noqa: BLE001
        tesseract = False

    from .tts.registry import engine_status

    return {
        "workerVersion": VERSION,
        "python": sys.version.split()[0],
        "machine": platform.machine(),
        "pymupdf": fitz.VersionBind,
        "tesseract": tesseract,
        "tts": engine_status(),
    }

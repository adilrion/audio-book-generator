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

    from .pdf.extract import ocr_setup
    from .tts.registry import engine_status

    tts = engine_status()
    return {
        "workerVersion": VERSION,
        "python": sys.version.split()[0],
        "machine": platform.machine(),
        "pymupdf": fitz.VersionBind,
        "tesseract": tesseract,
        # Bangla readiness: OCR language data (TESSDATA_DIR or Tesseract's own folder) and a Bangla Piper voice.
        "ocrBangla": ocr_setup("ben") is not None,
        "banglaVoices": _bangla_voices() if tts.get("piper", {}).get("available") else 0,
        "tts": tts,
    }


def _bangla_voices() -> int:
    from .tts.piper_engine import PiperEngine

    try:
        return sum(v.language == "bn" for v in PiperEngine().voices())
    except Exception:  # noqa: BLE001
        return 0

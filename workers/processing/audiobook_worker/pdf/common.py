from __future__ import annotations

import os

import pymupdf as fitz

from ..errors import WorkerError


def open_pdf(path: str, password: str | None = None) -> fitz.Document:
    if not os.path.exists(path):
        raise WorkerError("PDF_NOT_FOUND", f"PDF file not found: {path}")
    if os.path.getsize(path) == 0:
        raise WorkerError("PDF_EMPTY", "The PDF file is empty.")
    try:
        doc = fitz.open(path)
    except Exception as e:  # noqa: BLE001
        raise WorkerError("PDF_CORRUPT", "The PDF could not be opened. It may be corrupt or not a PDF.",
                          {"reason": str(e)}) from e
    if not doc.is_pdf:
        doc.close()
        raise WorkerError("PDF_UNSUPPORTED", "The file is not a PDF document.")
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            doc.close()
            raise WorkerError("PDF_PASSWORD", "The PDF is password-protected.")
    if doc.page_count == 0:
        doc.close()
        raise WorkerError("PDF_EMPTY", "The PDF has no pages.")
    return doc


def page_has_images(page: fitz.Page) -> bool:
    try:
        return len(page.get_images(full=False)) > 0
    except Exception:  # noqa: BLE001
        return False

"""Fast PDF inspection used right after upload (page count, word estimate, scan detection)."""
from __future__ import annotations

import os

from .common import open_pdf, page_has_images


def inspect_pdf(path: str, password: str | None = None, sample: int = 12) -> dict:
    doc = open_pdf(path, password)
    try:
        n = doc.page_count
        idxs = sorted({int(i * (n - 1) / max(1, sample - 1)) for i in range(min(sample, n))})
        words = 0
        empty_with_images = 0
        for i in idxs:
            page = doc[i]
            w = len(page.get_text("words"))
            words += w
            if w < 5 and page_has_images(page):
                empty_with_images += 1
        meta = doc.metadata or {}
        return {
            "pageCount": n,
            "encrypted": bool(doc.is_encrypted),
            "needsPassword": bool(doc.needs_pass),
            "title": (meta.get("title") or "").strip() or None,
            "author": (meta.get("author") or "").strip() or None,
            "estimatedWords": int(words / len(idxs) * n) if idxs else 0,
            "likelyScanned": empty_with_images >= max(1, int(len(idxs) * 0.6)),
            "hasToc": len(doc.get_toc(simple=True)) > 0,
            "fileSize": os.path.getsize(path),
        }
    finally:
        doc.close()


def inspect_rpc(params: dict, ctx) -> dict:
    return inspect_pdf(params["path"], params.get("password"))

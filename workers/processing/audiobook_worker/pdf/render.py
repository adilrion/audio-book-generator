"""Page rasterization. Pages are rendered one at a time at a bounded resolution."""
from __future__ import annotations

import os
from pathlib import Path

import pymupdf as fitz

from ..util import atomic_path
from .common import open_pdf

MAX_PIXELS = 12_000_000  # hard cap per page (~36MB RGB) regardless of requested scale


def _clamped_matrix(page: fitz.Page, scale: float) -> fitz.Matrix:
    w, h = page.rect.width * scale, page.rect.height * scale
    if w * h > MAX_PIXELS:
        scale *= (MAX_PIXELS / (w * h)) ** 0.5
    return fitz.Matrix(scale, scale)


def effective_scale(page: fitz.Page, scale: float) -> float:
    """The pixels-per-point a page is actually rendered at for a requested scale (after the MAX_PIXELS cap)."""
    return _clamped_matrix(page, scale).a


def render_page(doc: fitz.Document, page_no: int, scale: float, out_path: str) -> dict:
    page = doc[page_no - 1]
    m = _clamped_matrix(page, scale)
    pix = page.get_pixmap(matrix=m, alpha=False, colorspace=fitz.csRGB)
    ext = Path(out_path).suffix.lower()
    with atomic_path(out_path) as tmp:
        if ext in (".jpg", ".jpeg"):
            pix.save(tmp, output="jpg", jpg_quality=88)
        else:
            pix.save(tmp, output="png")
    return {"page": page_no, "path": out_path, "width": pix.width, "height": pix.height, "scale": m.a}


def render_pages_rpc(params: dict, ctx) -> dict:
    """params: path, pages[], scale, outDir, format(png|jpg). Skips pages already rendered."""
    doc = open_pdf(params["path"], params.get("password"))
    fmt = params.get("format", "png")
    out_dir = Path(params["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = params["pages"]
    results = []
    try:
        for i, p in enumerate(pages):
            out = out_dir / f"page-{p:04d}.{fmt}"
            if out.exists() and out.stat().st_size > 0:
                page = doc[p - 1]
                m = _clamped_matrix(page, params["scale"])
                results.append({"page": p, "path": str(out), "scale": m.a,
                                "width": int(page.rect.width * m.a), "height": int(page.rect.height * m.a)})
            else:
                results.append(render_page(doc, p, params["scale"], str(out)))
            ctx.progress(i + 1, len(pages), f"Rendered page {p}")
    finally:
        doc.close()
    return {"pages": results}


def render_preview_rpc(params: dict, ctx) -> dict:
    doc = open_pdf(params["path"], params.get("password"))
    try:
        out = params["outPath"]
        if os.path.exists(out) and os.path.getsize(out) > 0:
            return {"path": out}
        return render_page(doc, int(params["page"]), float(params.get("scale", 1.5)), out)
    finally:
        doc.close()

"""Streaming PDF text extraction with word-level bounding boxes.

Writes one JSON object per page to pages.jsonl so the whole book is never held in memory.
Output schema matches `ExtractedPage` in packages/types/src/pdf.ts.

We deliberately do NOT use PyMuPDF's built-in de-hyphenation: the orchestrator needs every
printed word with its own bbox so it can merge hyphenated words while keeping both
highlight rectangles.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pymupdf as fitz

from .. import EXTRACTOR_VERSION
from ..errors import WorkerError
from ..util import atomic_path
from .common import open_pdf, page_has_images

TEXT_FLAGS = fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP
MIN_TEXT_CHARS = 20


def _r(v: float) -> float:
    return round(float(v), 2)


def _rect(b, matrix: fitz.Matrix | None) -> list[float]:
    r = fitz.Rect(b)
    if matrix is not None:
        r = r * matrix
        r.normalize()
    return [_r(r.x0), _r(r.y0), _r(r.x1), _r(r.y1)]


def _line_from_raw(line: dict, matrix: fitz.Matrix | None) -> dict | None:
    """Convert a rawdict line into {b,size,font,bold,italic,words:[{t,b}]}."""
    d = line.get("dir", (1, 0))
    if abs(d[1]) > 0.1 or d[0] < 0:  # skip vertical / rotated text (margins, watermarks)
        return None
    words: list[dict] = []
    cur_text: list[str] = []
    cur_box: fitz.Rect | None = None
    size_weight: dict[float, int] = {}
    font_weight: dict[str, int] = {}
    bold_chars = italic_chars = total_chars = 0

    def flush():
        nonlocal cur_text, cur_box
        if cur_text and cur_box is not None:
            words.append({"t": "".join(cur_text), "b": _rect(cur_box, matrix)})
        cur_text, cur_box = [], None

    for span in line.get("spans", []):
        size = round(span.get("size", 0), 1)
        font = span.get("font", "")
        flags = span.get("flags", 0)
        is_bold = bool(flags & 16) or "bold" in font.lower() or "black" in font.lower()
        is_italic = bool(flags & 2) or "italic" in font.lower() or "oblique" in font.lower()
        for ch in span.get("chars", []):
            c = ch.get("c", "")
            if not c:
                continue
            if c.isspace() or c == " ":
                flush()
                continue
            total_chars += 1
            size_weight[size] = size_weight.get(size, 0) + 1
            font_weight[font] = font_weight.get(font, 0) + 1
            bold_chars += is_bold
            italic_chars += is_italic
            cb = fitz.Rect(ch["bbox"])
            cur_box = cb if cur_box is None else cur_box | cb
            cur_text.append(c)
    flush()
    if not words:
        return None
    return {
        "b": _rect(line["bbox"], matrix),
        "size": max(size_weight, key=size_weight.get) if size_weight else 0,
        "font": max(font_weight, key=font_weight.get) if font_weight else "",
        "bold": bold_chars > total_chars / 2,
        "italic": italic_chars > total_chars / 2,
        "words": words,
    }


def extract_page(page: fitz.Page, textpage=None) -> dict:
    matrix = page.rotation_matrix if page.rotation else None
    raw = page.get_text("rawdict", flags=TEXT_FLAGS, textpage=textpage)
    blocks = []
    for block in raw.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        lines = [ln for ln in (_line_from_raw(l, matrix) for l in block.get("lines", [])) if ln]
        if lines:
            blocks.append({"b": _rect(block["bbox"], matrix), "lines": lines})
    return {"page": page.number + 1, "width": _r(page.rect.width), "height": _r(page.rect.height), "blocks": blocks}


def _char_count(p: dict) -> int:
    return sum(len(w["t"]) for b in p["blocks"] for ln in b["lines"] for w in ln["words"])


def tesseract_available() -> bool:
    try:
        fitz.get_tessdata()
        return True
    except Exception:  # noqa: BLE001
        return False


def extract(path: str, out_dir: str, pdf_hash: str, ocr: str = "auto", ocr_language: str = "eng",
            password: str | None = None, ctx=None) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = open_pdf(path, password)
    ocr_ok = ocr != "off" and tesseract_available()
    empty_pages: list[int] = []
    ocr_pages: list[int] = []
    words = 0
    sizes: list[list[float]] = []
    try:
        n = doc.page_count
        with atomic_path(out / "pages.jsonl") as tmp:
            with open(tmp, "w", encoding="utf-8") as fh:
                for i in range(n):
                    page = doc[i]
                    data = extract_page(page)
                    chars = _char_count(data)
                    wants_ocr = ocr == "force" or (ocr == "auto" and chars < MIN_TEXT_CHARS and page_has_images(page))
                    if wants_ocr and ocr_ok:
                        try:
                            tp = page.get_textpage_ocr(flags=TEXT_FLAGS, language=ocr_language, dpi=200, full=True)
                            data = extract_page(page, textpage=tp)
                            data["ocr"] = True
                            ocr_pages.append(i + 1)
                            chars = _char_count(data)
                        except Exception as e:  # noqa: BLE001
                            if ctx:
                                ctx.log(f"OCR failed on page {i + 1}: {e}")
                    if chars < MIN_TEXT_CHARS:
                        empty_pages.append(i + 1)
                    sizes.append([data["width"], data["height"]])
                    words += sum(len(ln["words"]) for b in data["blocks"] for ln in b["lines"])
                    fh.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
                    page = None  # release page resources early
                    if ctx:
                        ctx.progress(i + 1, n, f"Extracted page {i + 1} of {n}")

        if words == 0:
            scanned = len(empty_pages) == n
            if scanned and not ocr_ok:
                raise WorkerError("PDF_SCANNED", "This PDF looks scanned (images only) and OCR is not available.",
                                  {"hint": "brew install tesseract"})
            raise WorkerError("PDF_NO_TEXT", "No readable text was found in this PDF.")

        meta = doc.metadata or {}
        toc = [{"level": lvl, "title": (title or "").strip(), "page": page}
               for lvl, title, page, *_ in doc.get_toc(simple=True)]
        result = {
            "pdfHash": pdf_hash,
            "extractorVersion": EXTRACTOR_VERSION,
            "pageCount": n,
            "title": (meta.get("title") or "").strip() or None,
            "author": (meta.get("author") or "").strip() or None,
            "toc": toc,
            "wordCount": words,
            "emptyPages": empty_pages,
            "ocrPages": ocr_pages,
            "pagesFile": "pages.jsonl",
            "pageSizes": sizes,
        }
        with atomic_path(out / "meta.json") as tmp:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(result, fh, ensure_ascii=False)
        return result
    finally:
        doc.close()


def extract_rpc(params: dict, ctx) -> dict:
    return extract(params["path"], params["outDir"], params["pdfHash"], params.get("ocr", "auto"),
                   params.get("ocrLanguage", "eng"), params.get("password"), ctx)

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
import re
from pathlib import Path

import pymupdf as fitz

from .. import EXTRACTOR_VERSION
from ..errors import WorkerError
from ..util import atomic_path
from .common import open_pdf, page_has_images

TEXT_FLAGS = fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP
MIN_TEXT_CHARS = 20
# OCR'd text has no space characters. Tesseract writes every word as its own span; inside a span, a
# gap wider than this share of a character advance separates two words.
OCR_WORD_GAP = 0.5
# Font size of an OCR'd line from the height of its character boxes (body text: box ≈ 1.3 × size).
OCR_HEIGHT_TO_SIZE = 0.76
# A Bangla page whose text layer garbled more than this share of its words is read by OCR instead.
MAX_BANGLA_DAMAGE = 0.08

_BENGALI = re.compile(r"[\u0980-\u09ff]")
# A word never starts with a dependent sign (vowel sign, hasanta, nukta…): seen when vowel signs are
# stored in visual order ("িক" for "কি") or a conjunct glyph has no Unicode mapping.
_SIGN_START = re.compile(r"^[^\w\u0981-\u0983\u09bc\u09be-\u09cd\u09d7]*[\u0981-\u0983\u09bc\u09be-\u09cd\u09d7]")
_UNMAPPED = re.compile(r"[\ufffd\ue000-\uf8ff]")
# Legacy (ANSI) Bangla fonts such as SutonnyMJ store Bangla as Latin letters ("Avwg evsjvq").
_LEGACY_BANGLA_FONT = re.compile(r"MJ(?:\b|[-_,])|Sutonny|Bijoy|ANSI")


def _r(v: float) -> float:
    return round(float(v), 2)


def _rect(b, matrix: fitz.Matrix | None) -> list[float]:
    r = fitz.Rect(b)
    if matrix is not None:
        r = r * matrix
        r.normalize()
    return [_r(r.x0), _r(r.y0), _r(r.x1), _r(r.y1)]


def _line_from_raw(line: dict, matrix: fitz.Matrix | None, ocr: bool = False, size_from_height: bool = False) -> dict | None:
    """Convert a rawdict line into {b,size,font,bold,italic,words:[{t,b}]}.

    `ocr`: the line comes from Tesseract — words are told apart by spans and gaps, not spaces.
    `size_from_height`: take the font size from the character boxes. Tesseract stretches every word
    to its printed width, so span sizes swing by a third within one line of Bangla body text."""
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

    line_size = None
    if size_from_height:
        heights = sorted(ch["bbox"][3] - ch["bbox"][1] for sp in line.get("spans", []) for ch in sp.get("chars", []))
        line_size = round(heights[len(heights) // 2] * OCR_HEIGHT_TO_SIZE, 1) if heights else None
    for span in line.get("spans", []):
        size = line_size or round(span.get("size", 0), 1)
        font = span.get("font", "")
        flags = span.get("flags", 0)
        is_bold = bool(flags & 16) or "bold" in font.lower() or "black" in font.lower()
        is_italic = bool(flags & 2) or "italic" in font.lower() or "oblique" in font.lower()
        advance = 0.0
        prev_x0 = None
        if ocr:
            flush()  # every OCR'd word is its own span
            # The glyph-less OCR font gives each character of a word the same advance, but zero-width
            # marks (্ ু ়) collapse their boxes: measure gaps from the advance, not the previous box.
            widths = sorted(ch["bbox"][2] - ch["bbox"][0] for ch in span.get("chars", []) if ch["bbox"][2] - ch["bbox"][0] > 0.01)
            advance = widths[len(widths) // 2] if widths else 0.0
        for ch in span.get("chars", []):
            c = ch.get("c", "")
            if not c:
                continue
            if c.isspace() or c == " ":
                flush()
                continue
            cb = fitz.Rect(ch["bbox"])
            if ocr and prev_x0 is not None and advance and cb.x0 - (prev_x0 + advance) > OCR_WORD_GAP * advance:
                flush()  # two words that happened to share a span
            prev_x0 = cb.x0
            total_chars += 1
            size_weight[size] = size_weight.get(size, 0) + 1
            font_weight[font] = font_weight.get(font, 0) + 1
            bold_chars += is_bold
            italic_chars += is_italic
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


def extract_page(page: fitz.Page, textpage=None, ocr: bool = False, size_from_height: bool = False) -> dict:
    matrix = page.rotation_matrix if page.rotation else None
    raw = page.get_text("rawdict", flags=TEXT_FLAGS, textpage=textpage)
    blocks = []
    for block in raw.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        lines = [ln for ln in (_line_from_raw(l, matrix, ocr, size_from_height) for l in block.get("lines", [])) if ln]
        if lines and size_from_height:
            _even_sizes(lines, 0.6, 1.45)
        if lines:
            blocks.append({"b": _rect(block["bbox"], matrix), "lines": lines})
    if size_from_height:
        _even_sizes([ln for b in blocks for ln in b["lines"]], 0.75, 1.25)
    return {"page": page.number + 1, "width": _r(page.rect.width), "height": _r(page.rect.height), "blocks": blocks}


def _even_sizes(lines: list[dict], lo: float, hi: float) -> None:
    """Give OCR'd lines of about the same size one size: the median (by characters) of `lines`.
    Tesseract sizes each line by its own ink (a line without descenders comes out a third smaller),
    which would otherwise split paragraphs at every line and make body lines look like headings.
    Used per block, then per page."""
    sized = sorted((ln["size"], sum(len(w["t"]) for w in ln["words"])) for ln in lines)
    half, acc, med = sum(n for _, n in sized) / 2, 0, sized[0][0] if sized else 0
    for size, n in sized:
        acc += n
        if acc >= half:
            med = size
            break
    for ln in lines:
        if med * lo <= ln["size"] <= med * hi:
            ln["size"] = med


def _char_count(p: dict) -> int:
    return sum(len(w["t"]) for b in p["blocks"] for ln in b["lines"] for w in ln["words"])


def bangla_damage(data: dict) -> float:
    """Share of a page's Bangla words that its text layer garbled (0 = clean). 1.0 when the text is
    set in a legacy ANSI font (Bijoy/SutonnyMJ) — Latin letters standing for Bangla ones."""
    chars = legacy = words = bad = 0
    for b in data["blocks"]:
        for ln in b["lines"]:
            n = sum(len(w["t"]) for w in ln["words"])
            chars += n
            if _LEGACY_BANGLA_FONT.search(ln.get("font", "")):
                legacy += n
            for w in ln["words"]:
                t = w["t"]
                if _BENGALI.search(t) or _UNMAPPED.search(t):
                    words += 1
                    bad += bool(_UNMAPPED.search(t) or _SIGN_START.match(t))
    if chars >= MIN_TEXT_CHARS and legacy / chars > 0.3:
        return 1.0
    return bad / words if words >= 8 else 0.0


def _tessdata_dirs() -> list[str]:
    dirs = []
    if os.environ.get("TESSDATA_DIR"):
        dirs.append(os.environ["TESSDATA_DIR"])  # storage/models/tessdata (scripts/download-models.sh bangla)
    try:
        dirs.append(fitz.get_tessdata())
    except Exception:  # noqa: BLE001
        pass
    return [d for d in dirs if d and os.path.isdir(d)]


def ocr_setup(language: str = "eng") -> tuple[str, str] | None:
    """(tessdata dir, language) for OCR in `language` ("ben+eng"), or None when Tesseract or the
    language data is missing. Falls back to the first language alone ("ben") when only that is installed."""
    langs = [l for l in language.split("+") if l]
    for want in (langs, langs[:1]):
        for d in _tessdata_dirs():
            if want and all(os.path.exists(os.path.join(d, f"{l}.traineddata")) for l in want):
                return d, "+".join(want)
    return None


def tesseract_available(language: str = "eng") -> bool:
    return ocr_setup(language) is not None


def extract(path: str, out_dir: str, pdf_hash: str, ocr: str = "auto", ocr_language: str = "eng",
            password: str | None = None, ctx=None) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = open_pdf(path, password)
    setup = ocr_setup(ocr_language) if ocr != "off" else None
    ocr_ok = setup is not None
    bangla = ocr_language.startswith("ben")
    empty_pages: list[int] = []
    ocr_pages: list[int] = []
    garbled_pages: list[int] = []
    text_pages = 0
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
                    garbled = bangla and chars >= MIN_TEXT_CHARS and bangla_damage(data) > MAX_BANGLA_DAMAGE
                    text_pages += chars >= MIN_TEXT_CHARS
                    wants_ocr = ocr == "force" or (ocr == "auto" and ((chars < MIN_TEXT_CHARS and page_has_images(page)) or garbled))
                    if wants_ocr and ocr_ok:
                        try:
                            tp = page.get_textpage_ocr(flags=TEXT_FLAGS, language=setup[1], dpi=300 if bangla else 200,
                                                       full=True, tessdata=setup[0])
                            data = extract_page(page, textpage=tp, ocr=True, size_from_height=bangla)
                            data["ocr"] = True
                            ocr_pages.append(i + 1)
                            chars = _char_count(data)
                            garbled = False
                        except Exception as e:  # noqa: BLE001
                            if ctx:
                                ctx.log(f"OCR failed on page {i + 1}: {e}")
                    if garbled:
                        garbled_pages.append(i + 1)
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
                                  {"hint": "bash scripts/download-models.sh bangla" if bangla else "brew install tesseract"})
            raise WorkerError("PDF_NO_TEXT", "No readable text was found in this PDF.")
        if garbled_pages and len(garbled_pages) > text_pages * 0.5:
            raise WorkerError(
                "PDF_TEXT_GARBLED",
                "The Bangla text in this PDF cannot be read directly: it uses a legacy (Bijoy) font or a "
                "broken text layer, and Bangla OCR is not available to read the pages instead.",
                {"hint": "Install Bangla OCR with: bash scripts/download-models.sh bangla — then retry.",
                 "pages": garbled_pages[:20]})

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
            "garbledPages": garbled_pages,
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

"""Streaming PDF text extraction with word-level bounding boxes.

Writes one JSON object per page to pages.jsonl so the whole book is never held in memory.
Output schema matches `ExtractedPage` in packages/types/src/pdf.ts.

We deliberately do NOT use PyMuPDF's built-in de-hyphenation: the orchestrator needs every
printed word with its own bbox so it can merge hyphenated words while keeping both
highlight rectangles.
"""
from __future__ import annotations

import json
import multiprocessing
import os
import re
from collections import deque
from concurrent.futures import Future, ProcessPoolExecutor
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
# Below that, only its damaged words are replaced by their OCR'd spelling.
MAX_BANGLA_DAMAGE = 0.08

_BENGALI = re.compile(r"[\u0980-\u09ff]")
_UNMAPPED = re.compile(r"[\ufffd\ue000-\uf8ff]")
# Bangla consonants (incl. ড় ঢ় য় ৎ and the Assamese ৰ ৱ).
_CONSONANTS = frozenset(chr(c) for c in [*range(0x0995, 0x09BA), 0x09CE, 0x09DC, 0x09DD, 0x09DF, 0x09F0, 0x09F1])
_SIGNS = frozenset(chr(c) for c in [0x09BC, *range(0x09BE, 0x09CE), 0x09D7])  # nukta, vowel signs, hasanta, au mark
_JOINERS = frozenset("\u200c\u200d")


def damaged_word(t: str) -> bool:
    """A word a PDF text layer broke: unmapped glyphs, a joiner at its edge, or a dependent sign that
    does not follow a consonant — vowel signs stored in visual order ("িক" for "কি"), or a conjunct
    glyph with no Unicode mapping ("িতীয়" for "দ্বিতীয়", "উেগ" for "উদ্বেগ")."""
    if _UNMAPPED.search(t):
        return True
    if t[:1] in _JOINERS or t[-1:] in _JOINERS:  # MS Word puts ZWNJ where the spaces were
        return True
    prev = ""
    for ch in t:
        if ch in _SIGNS and ch != prev:  # a sign printed twice ("দ্বাারা") is repaired by the analyzer
            ok = prev in _CONSONANTS or prev == "\u09bc" or (ch == "\u09cd" and prev in _JOINERS) or (
                prev == "\u09c7" and ch in "\u09be\u09d7")  # ো ৌ written as two signs
            if not ok:
                return True
        prev = ch
    return False
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


def _line_from_raw(line: dict, matrix: fitz.Matrix | None, ocr: bool = False, size_from_height: bool = False,
                   text: str | None = None) -> dict | None:
    """Convert a rawdict line into {b,size,font,bold,italic,words:[{t,b}]}.

    `ocr`: the line comes from Tesseract — words are told apart by spans and gaps, not spaces.
    `size_from_height`: take the font size from the character boxes. Tesseract stretches every word
    to its printed width, so span sizes swing by a third within one line of Bangla body text.
    `text`: the line as MuPDF spells it from the PDF's ActualText (see `_line_texts`)."""
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
    chars = [ch.get("c", "") for sp in line.get("spans", []) for ch in sp.get("chars", []) if ch.get("c", "")]
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
    if text is not None and not ocr and _BENGALI.search(text):
        # Bangla PDFs (Chrome, Word) map several characters to one glyph through ActualText. MuPDF keeps
        # the whole string for the line, but its characters can lose a line's last cluster ("কিছু" → "কিছ").
        spelled = text.split()
        if len(spelled) == len(words):
            for w, t in zip(words, spelled):
                w["t"] = t
    space = lambda c: c.isspace() or c == " "  # noqa: E731
    return {
        "b": _rect(line["bbox"], matrix),
        "size": max(size_weight, key=size_weight.get) if size_weight else 0,
        "font": max(font_weight, key=font_weight.get) if font_weight else "",
        "bold": bold_chars > total_chars / 2,
        "italic": italic_chars > total_chars / 2,
        "words": words,
        # whitespace printed at the start / end of the line, for joining fragments (removed later)
        "_seam": (bool(chars) and space(chars[0]), bool(chars) and space(chars[-1])),
    }


def extract_page(page: fitz.Page, textpage=None, ocr: bool = False, size_from_height: bool = False) -> dict:
    matrix = page.rotation_matrix if page.rotation else None
    tp = textpage if textpage is not None else page.get_textpage(flags=TEXT_FLAGS)
    raw = page.get_text("rawdict", textpage=tp)
    text_blocks = [b for b in raw.get("blocks", []) if b.get("type", 0) == 0]
    texts = [] if ocr else _line_texts(page, tp, text_blocks)
    blocks = []
    for bi, block in enumerate(text_blocks):
        lt = texts[bi] if bi < len(texts) and texts[bi] else [None] * len(block.get("lines", []))
        lines = [ln for ln in (_line_from_raw(l, matrix, ocr, size_from_height, t) for l, t in zip(block.get("lines", []), lt)) if ln]
        lines = _join_fragments(lines)
        for ln in lines:
            ln.pop("_seam", None)
        if lines and size_from_height:
            _even_sizes(lines, 0.6, 1.45)
        if lines:
            blocks.append({"b": _rect(block["bbox"], matrix), "lines": lines})
    if size_from_height:
        _even_sizes([ln for b in blocks for ln in b["lines"]], 0.75, 1.25)
    return {"page": page.number + 1, "width": _r(page.rect.width), "height": _r(page.rect.height), "blocks": blocks}


def _line_texts(page: fitz.Page, tp, text_blocks: list[dict]) -> list[list[str] | None]:
    """Each text block's lines as MuPDF spells them from the PDF's ActualText ("blocks" output),
    aligned with the rawdict lines; None for a block whose lines do not line up."""
    try:
        found = [b for b in page.get_text("blocks", textpage=tp) if b[6] == 0]
    except Exception:  # noqa: BLE001
        return []
    if len(found) != len(text_blocks):
        return []
    out: list[list[str] | None] = []
    for rb, bb in zip(text_blocks, found):
        lines = bb[4].split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        out.append(lines if len(lines) == len(rb.get("lines", [])) else None)
    return out


def _join_fragments(lines: list[dict]) -> list[dict]:
    """MuPDF sometimes cuts one printed Bangla line into pieces on the same baseline ("জিজ্ঞে" |
    "স করল…"), which would read as a new, indented line. Join them; a word cut at a seam with no
    space printed on either side is one word."""
    out: list[dict] = []
    for ln in lines:
        prev = out[-1] if out else None
        if prev is None or not _continues(prev, ln):
            out.append(ln)
            continue
        size = max(prev["size"], ln["size"], 1.0)
        rest = ln["words"]
        if not prev["_seam"][1] and not ln["_seam"][0] and ln["b"][0] - prev["b"][2] < size:
            w0, w1 = prev["words"][-1], ln["words"][0]
            w0["t"] += w1["t"]
            w0["b"] = [min(w0["b"][0], w1["b"][0]), min(w0["b"][1], w1["b"][1]), max(w0["b"][2], w1["b"][2]), max(w0["b"][3], w1["b"][3])]
            rest = rest[1:]
        prev["words"] += rest
        prev["b"] = [min(prev["b"][0], ln["b"][0]), min(prev["b"][1], ln["b"][1]), max(prev["b"][2], ln["b"][2]), max(prev["b"][3], ln["b"][3])]
        prev["_seam"] = (prev["_seam"][0], ln["_seam"][1])
    return out


def _continues(a: dict, b: dict) -> bool:
    """Is `b` the rest of `a`'s printed line: same baseline, just to its right, Bangla at the seam?"""
    (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = a["b"], b["b"]
    size = max(a["size"], b["size"], 1.0)
    overlap = min(ay1, by1) - max(ay0, by0)
    return (overlap > 0.6 * min(ay1 - ay0, by1 - by0) and abs(ay1 - by1) < 0.3 * size and -0.5 * size < bx0 - ax1 < 1.5 * size
            and bool(_BENGALI.search(a["words"][-1]["t"])) and bool(_BENGALI.search(b["words"][0]["t"])))


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
                    bad += damaged_word(t)
    if chars >= MIN_TEXT_CHARS and legacy / chars > 0.3:
        return 1.0
    return bad / words if words else 0.0


def _ocr_words(page: fitz.Page, setup: tuple[str, str], clip: fitz.Rect | None = None) -> list[tuple[fitz.Rect, str]]:
    """OCR'd words of `clip` (or the whole page) with their boxes in page coordinates."""
    if clip is None:
        tp = page.get_textpage_ocr(flags=TEXT_FLAGS, language=setup[1], dpi=300, full=True, tessdata=setup[0])
        data = extract_page(page, textpage=tp, ocr=True)
        return [(fitz.Rect(w["b"]), w["t"]) for b in data["blocks"] for ln in b["lines"] for w in ln["words"]]
    pix = page.get_pixmap(dpi=300, clip=clip, colorspace=fitz.csRGB)  # Tesseract reads nothing from a gray pixmap here
    with fitz.open("pdf", pix.pdfocr_tobytes(language=setup[1], tessdata=setup[0])) as doc:
        op = doc[0]
        sx, sy = clip.width / op.rect.width, clip.height / op.rect.height
        return [(fitz.Rect(clip.x0 + w["b"][0] * sx, clip.y0 + w["b"][1] * sy, clip.x0 + w["b"][2] * sx, clip.y0 + w["b"][3] * sy), w["t"])
                for b in extract_page(op, ocr=True)["blocks"] for ln in b["lines"] for w in ln["words"]]


def repair_lines_with_ocr(page: fitz.Page, data: dict, setup: tuple[str, str]) -> int:
    """On a page whose text layer is mostly good, take the OCR'd spelling of each damaged Bangla word
    (Chrome's Kohinoor Bangla drops দ্ব before ি and ে). The printed boxes are kept. A few damaged
    lines are OCR'd one by one; more than that, the whole page once. Returns the words repaired."""
    lines = [ln for b in data["blocks"] for ln in b["lines"] if any(damaged_word(w["t"]) for w in ln["words"])]
    if not lines:
        return 0
    whole = None
    if len(lines) > 3 or page.rotation:
        try:
            whole = _ocr_words(page, setup)
        except Exception:  # noqa: BLE001 — a failed repair keeps the text layer's words
            return 0
    fixed = 0
    for ln in lines:
        found = whole
        if found is None:
            r = fitz.Rect(ln["b"])
            pad = r.height * 0.3
            try:
                found = _ocr_words(page, setup, fitz.Rect(r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad) & page.rect)
            except Exception:  # noqa: BLE001
                continue
        for w in ln["words"]:
            if not damaged_word(w["t"]):
                continue
            wb = fitz.Rect(w["b"])
            # OCR'd words that lie mostly inside this word's printed box, on its line
            parts = [t for ob, t in found if ob.width > 0 and ob.y0 < wb.y1 and ob.y1 > wb.y0
                     and min(ob.x1, wb.x1) - max(ob.x0, wb.x0) > 0.5 * ob.width]
            cand = "".join(parts)
            if cand and _BENGALI.search(cand) and not damaged_word(cand) and len(cand) <= 2 * len(w["t"]) + 4:
                w["t"] = cand
                fixed += 1
    return fixed


def _tessdata_dirs() -> list[str]:
    """Tesseract's own language data first (so English OCR does not change when the Bangla pack is
    added), then storage/models/tessdata from `scripts/download-models.sh bangla`."""
    dirs = []
    try:
        dirs.append(fitz.get_tessdata())
    except Exception:  # noqa: BLE001
        pass
    if os.environ.get("TESSDATA_DIR"):
        dirs.append(os.environ["TESSDATA_DIR"])
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


def _triage(page: fitz.Page, ocr: str, setup: tuple[str, str] | None, bangla: bool) -> tuple[dict, str | None, float]:
    """The page's text layer, and what it still needs: "ocr", "repair" (OCR only damaged words) or None."""
    data = extract_page(page)
    chars = _char_count(data)
    damage = bangla_damage(data) if bangla and chars >= MIN_TEXT_CHARS else 0.0
    wants_ocr = ocr == "force" or (ocr == "auto" and ((chars < MIN_TEXT_CHARS and page_has_images(page)) or damage > MAX_BANGLA_DAMAGE))
    if setup is None:
        return data, None, damage
    return data, "ocr" if wants_ocr else ("repair" if damage > 0 else None), damage


def _page_work(page: fitz.Page, data: dict, work: str, setup: tuple[str, str], bangla: bool) -> tuple[dict, dict]:
    """Do the OCR a page needs. Returns (page data, {"ocr", "repaired", "error"})."""
    info = {"ocr": False, "repaired": 0, "error": None}
    if work == "ocr":
        try:
            tp = page.get_textpage_ocr(flags=TEXT_FLAGS, language=setup[1], dpi=300 if bangla else 200, full=True, tessdata=setup[0])
            data = extract_page(page, textpage=tp, ocr=True, size_from_height=bangla)
            data["ocr"] = info["ocr"] = True
        except Exception as e:  # noqa: BLE001
            info["error"] = f"OCR failed on page {page.number + 1}: {e}"
    elif work == "repair":
        info["repaired"] = repair_lines_with_ocr(page, data, setup)
    return data, info


# ── OCR worker processes (Tesseract is single-threaded: a 300-page Bangla book is ~10 s per page) ──
_worker_doc: fitz.Document | None = None


def _init_worker(path: str, password: str | None) -> None:
    global _worker_doc
    _worker_doc = open_pdf(path, password)


def _page_job(i: int, ocr: str, setup: tuple[str, str], bangla: bool) -> tuple[dict, dict]:
    page = _worker_doc[i]
    data, work, _ = _triage(page, ocr, setup, bangla)
    return _page_work(page, data, work, setup, bangla) if work else (data, {"ocr": False, "repaired": 0, "error": None})


def extract(path: str, out_dir: str, pdf_hash: str, ocr: str = "auto", ocr_language: str = "eng",
            password: str | None = None, ctx=None, ocr_workers: int = 1) -> dict:
    """`ocr_workers` > 1 reads the pages that need OCR in that many processes; pages are still
    written in order, with only a few pages in flight."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = open_pdf(path, password)
    setup = ocr_setup(ocr_language) if ocr != "off" else None
    ocr_ok = setup is not None
    bangla = ocr_language.startswith("ben")
    empty_pages: list[int] = []
    ocr_pages: list[int] = []
    garbled_pages: list[int] = []
    repaired_words = 0
    text_pages = 0
    words = 0
    sizes: list[list[float]] = []
    pool = None
    try:
        n = doc.page_count
        pending: deque = deque()  # (page index, text-layer damage, Future | (data, info)) in page order

        def write_next(fh) -> None:
            nonlocal repaired_words, words
            i, damage, item = pending.popleft()
            data, info = item.result() if isinstance(item, Future) else item
            if info["error"] and ctx:
                ctx.log(info["error"])
            if info["ocr"]:
                ocr_pages.append(i + 1)
            elif damage > MAX_BANGLA_DAMAGE:
                garbled_pages.append(i + 1)  # damaged, and OCR could not read it instead
            repaired_words += info["repaired"]
            if _char_count(data) < MIN_TEXT_CHARS:
                empty_pages.append(i + 1)
            sizes.append([data["width"], data["height"]])
            words += sum(len(ln["words"]) for b in data["blocks"] for ln in b["lines"])
            fh.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
            if ctx:
                ctx.progress(i + 1, n, f"Read page {i + 1} of {n} with OCR" if info["ocr"] else f"Extracted page {i + 1} of {n}")

        with atomic_path(out / "pages.jsonl") as tmp:
            with open(tmp, "w", encoding="utf-8") as fh:
                for i in range(n):
                    page = doc[i]
                    data, work, damage = _triage(page, ocr, setup, bangla)
                    text_pages += _char_count(data) >= MIN_TEXT_CHARS
                    none = {"ocr": False, "repaired": 0, "error": None}
                    if work and ocr_workers > 1:
                        if pool is None:
                            pool = ProcessPoolExecutor(ocr_workers, mp_context=multiprocessing.get_context("spawn"),
                                                       initializer=_init_worker, initargs=(path, password))
                        pending.append((i, damage, pool.submit(_page_job, i, ocr, setup, bangla)))
                    else:
                        pending.append((i, damage, _page_work(page, data, work, setup, bangla) if work else (data, none)))
                    page = None  # release page resources early
                    while pending and (not isinstance(pending[0][2], Future) or pending[0][2].done() or len(pending) > 2 * ocr_workers):
                        write_next(fh)
                while pending:
                    write_next(fh)

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
            "ocrRepairedWords": repaired_words,
            "pagesFile": "pages.jsonl",
            "pageSizes": sizes,
        }
        with atomic_path(out / "meta.json") as tmp:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(result, fh, ensure_ascii=False)
        return result
    finally:
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
        doc.close()


def extract_rpc(params: dict, ctx) -> dict:
    return extract(params["path"], params["outDir"], params["pdfHash"], params.get("ocr", "auto"),
                   params.get("ocrLanguage", "eng"), params.get("password"), ctx, int(params.get("ocrWorkers", 1)))

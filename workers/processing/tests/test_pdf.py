import json

import pymupdf as fitz
import pytest

from audiobook_worker.errors import WorkerError
from audiobook_worker.pdf.extract import extract
from audiobook_worker.pdf.inspect import inspect_pdf
from audiobook_worker.pdf.render import render_pages_rpc


class Ctx:
    def progress(self, *a, **k):
        pass

    def log(self, *a, **k):
        pass


def test_inspect(sample_pdf):
    info = inspect_pdf(sample_pdf)
    assert info["pageCount"] >= 3
    assert info["estimatedWords"] > 30
    assert info["hasToc"] is True
    assert info["likelyScanned"] is False


def test_extract_words_with_bboxes(sample_pdf, tmp_path):
    meta = extract(sample_pdf, str(tmp_path), "hash123", ocr="off")
    assert meta["pageCount"] >= 3
    assert meta["toc"][0]["title"].startswith("Chapter 1")
    pages = [json.loads(l) for l in open(tmp_path / "pages.jsonl")]
    assert len(pages) == meta["pageCount"]
    p2 = pages[1]
    words = [w for b in p2["blocks"] for ln in b["lines"] for w in ln["words"]]
    assert any(w["t"] == "Chapter" for w in words)
    for w in words:
        x0, y0, x1, y1 = w["b"]
        assert 0 <= x0 < x1 <= p2["width"] + 1 and 0 <= y0 < y1 <= p2["height"] + 1
    # heading font is larger than body
    sizes = sorted({ln["size"] for b in p2["blocks"] for ln in b["lines"]})
    assert sizes[-1] >= 16
    # hyphenated fragments are preserved (orchestrator merges them, keeping both bboxes)
    all_words = [w["t"] for p in pages for b in p["blocks"] for ln in b["lines"] for w in ln["words"]]
    assert any(t.endswith("-") for t in all_words)


def test_corrupt_pdf(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a pdf at all")
    with pytest.raises(WorkerError) as e:
        inspect_pdf(str(bad))
    assert e.value.code in ("PDF_CORRUPT", "PDF_UNSUPPORTED")


def test_empty_file(tmp_path):
    f = tmp_path / "empty.pdf"
    f.write_bytes(b"")
    with pytest.raises(WorkerError) as e:
        inspect_pdf(str(f))
    assert e.value.code == "PDF_EMPTY"


def test_password_pdf(tmp_path, sample_pdf):
    doc = fitz.open(sample_pdf)
    out = tmp_path / "locked.pdf"
    doc.save(str(out), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    doc.close()
    with pytest.raises(WorkerError) as e:
        inspect_pdf(str(out))
    assert e.value.code == "PDF_PASSWORD"
    assert inspect_pdf(str(out), password="secret")["pageCount"] > 0


def test_image_only_pdf_without_ocr(tmp_path):
    doc = fitz.open()
    page = doc.new_page()
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 50), False)
    pix.clear_with(200)
    page.insert_image(page.rect, pixmap=pix)
    p = tmp_path / "scan.pdf"
    doc.save(str(p))
    with pytest.raises(WorkerError) as e:
        extract(str(p), str(tmp_path / "out"), "h", ocr="off")
    assert e.value.code in ("PDF_SCANNED", "PDF_NO_TEXT")


def test_render_pages(sample_pdf, tmp_path):
    res = render_pages_rpc({"path": sample_pdf, "pages": [1, 2], "scale": 1.5, "outDir": str(tmp_path)}, Ctx())
    assert len(res["pages"]) == 2
    assert (tmp_path / "page-0001.png").exists()
    assert abs(res["pages"][0]["scale"] - 1.5) < 1e-6

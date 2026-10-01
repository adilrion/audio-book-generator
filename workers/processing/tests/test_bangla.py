"""Bangla: garbled text layers → OCR, OCR word splitting, Piper's multi-speaker Bangla voice, title fonts."""
import json
import os
from pathlib import Path

import pymupdf as fitz
import pytest

from audiobook_worker.errors import WorkerError
from audiobook_worker.pdf import extract as ex
from audiobook_worker.tts import piper_engine
from audiobook_worker.video.compositor import shorten, title_font_candidates

BANGLA_FONTS = [
    "/System/Library/Fonts/KohinoorBangla.ttc",
    "/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf",
]
BANGLA_FONT = next((f for f in BANGLA_FONTS if os.path.exists(f)), None)
needs_font = pytest.mark.skipif(BANGLA_FONT is None, reason="no Bangla font installed")


def _page(words: list[str], font: str = "KohinoorBangla") -> dict:
    return {"blocks": [{"lines": [{"font": font, "words": [{"t": w} for w in words]}]}]}


def test_bangla_damage():
    clean = "কিছু দিন আগে তিনি বাড়ি গেলেন। সেখানে কৈলাস বাবু থাকতেন".split()
    assert ex.bangla_damage(_page(clean)) == 0.0
    # Vowel signs stored in visual order and conjuncts without a Unicode mapping (MuPDF, MS Word…).
    visual = "ক িছু দ িন আগ ে ত িন ি বাড় ি গ�লন".split()
    assert ex.bangla_damage(_page(visual)) > ex.MAX_BANGLA_DAMAGE
    # One lost conjunct on a page of text ("িতীয়") is not worth OCR.
    assert ex.bangla_damage(_page(clean * 5 + ["িতীয়"])) < ex.MAX_BANGLA_DAMAGE
    # Bijoy (ANSI) fonts: Bangla typed as Latin letters.
    assert ex.bangla_damage(_page("Avwg evsjvq Mvb MvB Avgvi †mvbvi evsjv".split(), font="ABCDEF+SutonnyMJ")) == 1.0
    assert ex.bangla_damage(_page("The quick brown fox jumps over the lazy dog".split(), font="Times-Roman")) == 0.0


def _char(c: str, x0: float, x1: float) -> dict:
    return {"c": c, "bbox": (x0, 100.0, x1, 118.0), "origin": (x0, 118.0)}


def _span(chars: list[dict], size: float) -> dict:
    return {"size": size, "font": "GlyphLessFont", "flags": 0, "chars": chars}


def test_ocr_words_are_split_at_spans_not_at_zero_width_marks():
    # Tesseract's glyph-less font: one span per word, equal advances, zero-width boxes for ্ ু ়.
    probhom = [_char("প", 50, 59), _char("্", 59, 59), _char("র", 68, 77), _char("থ", 77, 86), _char("ম", 86, 95)]
    kichu = [_char("ক", 100, 105.5), _char("ি", 105.5, 111), _char("ছ", 111, 116.5), _char("ু", 116.5, 116.5)]
    din = [_char("দ", 119.5, 126.5), _char("ি", 126.5, 133.5), _char("ন", 133.5, 140.5)]  # 3pt gap: still a new word
    line = {"dir": (1, 0), "bbox": (50, 100, 141, 118), "spans": [_span(probhom, 18.6), _span(kichu, 14.1), _span(din, 15.8)]}
    out = ex._line_from_raw(line, None, ocr=True, size_from_height=True)
    assert [w["t"] for w in out["words"]] == ["প্রথম", "কিছু", "দিন"]
    assert out["size"] == round(18 * ex.OCR_HEIGHT_TO_SIZE, 1)  # from the box height, not the stretched spans
    # Two words that share a span are told apart by the gap after the expected advance.
    shared = [_char("আ", 50, 55), _char("ম", 55, 60), _char("ি", 60, 65), _char("ত", 72, 77), _char("ু", 77, 77), _char("ম", 82, 87)]
    line = {"dir": (1, 0), "bbox": (50, 100, 87, 118), "spans": [_span(shared, 14)]}
    assert [w["t"] for w in ex._line_from_raw(line, None, ocr=True)["words"]] == ["আমি", "তুম"]
    # Without the OCR flag nothing changes: words end at spaces only.
    assert [w["t"] for w in ex._line_from_raw(line, None)["words"]] == ["আমিতুম"]


def test_ocr_sizes_are_evened_out():
    lines = [{"size": s, "words": [{"t": "শব্দ" * 5}]} for s in (11.9, 9.4, 14.6, 12.2, 20.0, 8.0)]
    ex._even_sizes(lines, 0.75, 1.25)
    assert [ln["size"] for ln in lines] == [11.9, 11.9, 11.9, 11.9, 20.0, 8.0]  # headings and footnotes keep theirs


def test_ocr_setup_finds_language_data(tmp_path, monkeypatch):
    monkeypatch.setenv("TESSDATA_DIR", str(tmp_path))
    monkeypatch.setattr(fitz, "get_tessdata", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no tesseract")))
    assert ex.ocr_setup("ben+eng") is None
    (tmp_path / "ben.traineddata").write_bytes(b"x")
    assert ex.ocr_setup("ben+eng") == (str(tmp_path), "ben")  # English data missing: Bangla alone
    (tmp_path / "eng.traineddata").write_bytes(b"x")
    assert ex.ocr_setup("ben+eng") == (str(tmp_path), "ben+eng")


def _garbled_pdf(path: Path, pages: int = 2) -> None:
    """A text layer as broken Bangla PDFs have it: vowel signs before their consonant."""
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page(width=432, height=648)
        for i in range(6):
            page.insert_text((54, 80 + 22 * i), "ক িছু দ িন আগ ে ত িন ি বাড় ি গ েল েন। স েখান ে ক ৈলাস", fontfile=BANGLA_FONT, fontname="bn", fontsize=12)
    doc.save(str(path))


@needs_font
def test_garbled_bangla_without_ocr_fails_clearly(tmp_path, monkeypatch):
    path = tmp_path / "garbled.pdf"
    _garbled_pdf(path)
    monkeypatch.setattr(ex, "ocr_setup", lambda language="eng": None)
    with pytest.raises(WorkerError) as e:
        ex.extract(str(path), str(tmp_path / "out"), "h", ocr="auto", ocr_language="ben+eng")
    assert e.value.code == "PDF_TEXT_GARBLED"
    assert "download-models.sh bangla" in e.value.details["hint"]
    # English projects never look for Bangla damage.
    meta = ex.extract(str(path), str(tmp_path / "out-en"), "h", ocr="auto", ocr_language="eng")
    assert meta["garbledPages"] == []


@needs_font
@pytest.mark.skipif(ex.ocr_setup("ben") is None, reason="Bangla OCR data not installed (scripts/download-models.sh bangla)")
def test_garbled_bangla_page_is_read_with_ocr(tmp_path):
    # Typeset real Bangla with HarfBuzz (correct picture), but MuPDF's own text layer for it is garbled.
    doc = fitz.open()
    page = doc.new_page()
    css = f"@font-face {{font-family: bn; src: url({BANGLA_FONT});}} * {{font-family: bn; font-size: 15px}}"
    html = "<p>কিছু দিন আগে তিনি বাড়ি গেলেন। সেখানে কৈলাস বাবু থাকতেন। ছোট্ট পাখিটি গান গাইছিল।</p>" * 3
    page.insert_htmlbox(fitz.Rect(50, 50, 545, 500), html, css=css, archive=fitz.Archive("/"))
    path = tmp_path / "bn.pdf"
    doc.save(str(path))
    assert ex.bangla_damage(ex.extract_page(fitz.open(str(path))[0])) > ex.MAX_BANGLA_DAMAGE

    meta = ex.extract(str(path), str(tmp_path / "out"), "h", ocr="auto", ocr_language="ben+eng")
    assert meta["ocrPages"] == [1] and meta["garbledPages"] == []
    p = json.loads(open(tmp_path / "out" / "pages.jsonl").readline())
    words = [w["t"] for b in p["blocks"] for ln in b["lines"] for w in ln["words"]]
    for w in ("কিছু", "দিন", "আগে", "তিনি", "বাড়ি", "গেলেন।"):
        assert w in words


# ── Piper ───────────────────────────────────────────────────────────────────

def test_voice_ids_and_espeak_text():
    assert piper_engine.split_voice_id("bn_BD-google-medium:4811") == ("bn_BD-google-medium", "4811")
    assert piper_engine.split_voice_id("en_US-lessac-medium") == ("en_US-lessac-medium", None)
    # letter + nukta (NFC) → the single code point espeak-ng reads correctly
    assert piper_engine.espeak_friendly("বাড়ি দেওয়া", "bn") == "বাড়ি দেওয়া"
    assert piper_engine.espeak_friendly("বাড়ি", "en-us") == "বাড়ি"


def test_multi_speaker_voices_are_listed_per_speaker(tmp_path, monkeypatch):
    pytest.importorskip("piper")
    monkeypatch.setenv("PIPER_MODEL_DIR", str(tmp_path))
    (tmp_path / "bn_BD-google-medium.onnx").write_bytes(b"")
    (tmp_path / "bn_BD-google-medium.onnx.json").write_text(json.dumps({
        "language": {"family": "bn"}, "num_speakers": 3, "speaker_id_map": {"00737": 0, "4811": 1, "rm": 2}}))
    (tmp_path / "en_US-lessac-medium.onnx").write_bytes(b"")
    (tmp_path / "en_US-lessac-medium.onnx.json").write_text(json.dumps({"language": {"family": "en"}, "num_speakers": 1}))
    voices = {v.id: v for v in piper_engine.PiperEngine().voices()}
    assert set(voices) == {"bn_BD-google-medium:00737", "bn_BD-google-medium:4811", "bn_BD-google-medium:rm", "en_US-lessac-medium"}
    assert voices["bn_BD-google-medium:4811"].language == "bn"
    assert voices["bn_BD-google-medium:4811"].name == "Google 2"
    assert voices["bn_BD-google-medium:4811"].gender == "female"
    assert voices["bn_BD-google-medium:00737"].gender == "male"
    assert voices["en_US-lessac-medium"].name == "Lessac"


BN_MODEL = Path(os.environ.get("PIPER_MODEL_DIR", Path(__file__).resolve().parents[3] / "storage/models/piper")) / "bn_BD-google-medium.onnx"


@pytest.mark.skipif(not BN_MODEL.exists(), reason="Bangla Piper voice not installed (scripts/download-models.sh bangla)")
def test_bangla_voice_speaks_every_speaker_and_keeps_vowels(monkeypatch):
    monkeypatch.setenv("PIPER_MODEL_DIR", str(BN_MODEL.parent))
    eng = piper_engine.PiperEngine()
    v = eng._voice("bn_BD-google-medium")
    # The vowel after ড় is spoken: "বাড়ি" is "bar.i", not "bar."
    phonemes = "".join(sum(v.phonemize(piper_engine.espeak_friendly("বাড়ি", "bn")), []))
    assert phonemes.endswith("i")
    for speaker in ("4811", "rm", "00737"):
        audio, rate = eng.synthesize("আমার সোনার বাংলা।", f"bn_BD-google-medium:{speaker}", 1.0, "bn")
        assert rate == 22050 and 0.8 < audio.size / rate < 4
    with pytest.raises(WorkerError):
        eng.synthesize("আমি", "bn_BD-google-medium:nobody", 1.0, "bn")


# ── video ───────────────────────────────────────────────────────────────────

def test_bangla_titles_use_a_bangla_font():
    assert title_font_candidates("দ্বিতীয় অধ্যায়")[0].endswith(("KohinoorBangla.ttc", ".ttc", ".ttf"))
    assert any("Bangla" in f or "Bengali" in f for f in title_font_candidates("দ্বিতীয় অধ্যায়")[:3])
    assert not any("Bangla" in f or "Bengali" in f for f in title_font_candidates("Chapter 2"))
    long = "এটি একটি খুব লম্বা অধ্যায়ের শিরোনাম যা সত্তর অক্ষরের বেশি হবে এবং কাটা পড়বে শব্দের সীমানায়"
    cut = shorten(long)
    assert cut.endswith("…") and len(cut) <= 70 and long.startswith(cut[:-1])
    assert shorten("Chapter 2") == "Chapter 2"

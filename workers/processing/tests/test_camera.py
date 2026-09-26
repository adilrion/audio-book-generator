"""The highlighted words must be on screen whenever they are being read — for every aspect
ratio and camera style, on a normal book page and on a two-column page where reading jumps
from the bottom of one column to the top of the next (also in the middle of a sentence)."""
import numpy as np
import pymupdf as fitz
import pytest

from audiobook_worker.pdf.extract import extract_page
from audiobook_worker.sample import PARAS
from audiobook_worker.video.compositor import ChapterCompositor
from audiobook_worker.video.render_chapter import prepare_pages

FPS = 30


def _two_column_pdf(path: str) -> str:
    """Letter page, two columns; text flows from column 1 into column 2 mid-sentence."""
    font = fitz.Font("tiro")
    size, lead, top, bottom = 10.5, 14.0, 72.0, 720.0
    colw = (612 - 144 - 24) / 2
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_font(fontname="F0", fontbuffer=font.buffer)
    col, y, line = 0, top, ""
    for w in " ".join(PARAS * 6).split():
        trial = (line + " " + w).strip()
        if font.text_length(trial, size) <= colw:
            line = trial
            continue
        page.insert_text((72 + col * (colw + 24), y), line, fontname="F0", fontsize=size)
        line, y = w, y + lead
        if y > bottom:
            col, y = col + 1, top
            if col == 2:
                break
    doc.save(path)
    return path


def _sentence_segments(pdf: str, words_per_sec: float = 2.6, pause: float = 0.35):
    """Sentences → per-printed-line rects (like packages/pipeline regionsFor) with plausible timings."""
    doc = fitz.open(pdf)
    words, sizes = [], {}
    for i, page in enumerate(doc):
        d = extract_page(page)
        sizes[str(i + 1)] = {"w": d["width"], "h": d["height"]}
        for b in d["blocks"]:
            for ln in b["lines"]:
                if ln["size"] < 10:  # running header / page number
                    continue
                words += [(i + 1, w["t"], w["b"]) for w in ln["words"]]
    segs, cur, t = [], [], 0.5
    for pg, text, b in words:
        cur.append((pg, text, b))
        if not text.endswith((".", "?", "!", ":")) or text in ("Mr.", "e.g."):
            continue
        dur = len(cur) / words_per_sec
        for p in sorted({c[0] for c in cur}):
            mine = [c for c in cur if c[0] == p]
            rects = []
            for _, _, r in mine:
                last = rects[-1] if rects else None
                if last and abs((last[1] + last[3]) / 2 - (r[1] + r[3]) / 2) < (r[3] - r[1]) / 2 and r[0] >= last[0]:
                    last[2], last[1], last[3] = max(last[2], r[2]), min(last[1], r[1]), max(last[3], r[3])
                else:
                    rects.append(list(r))
            d = dur * len(mine) / len(cur)
            segs.append({"start": round(t, 3), "end": round(t + d, 3), "page": p, "rects": rects})
            t += d
        t += pause
        cur = []
    return segs, sizes


def _parts(seg):
    """[(start, end, rects)]: the whole sentence, or — when it continues at the top of the next
    column — one part per column, timed by printed width."""
    groups = [[seg["rects"][0]]]
    for r in seg["rects"][1:]:
        (groups[-1].append(r) if r[1] >= groups[-1][-1][1] else groups.append([r]))
    widths = np.array([sum(r[2] - r[0] for r in g) for g in groups])
    edges = seg["start"] + np.concatenate([[0], np.cumsum(widths) / widths.sum()]) * (seg["end"] - seg["start"])
    return [(edges[k], edges[k + 1], g) for k, g in enumerate(groups)]


# Inside a sentence there is no pause to pan in: allow a quick pan around a column break.
BREAK_ALLOWANCE = 0.2


def _reading_rects(seg, t):
    parts = _parts(seg)
    for a, b, rects in parts:
        if t < b:
            return rects, any(abs(t - x) < BREAK_ALLOWANCE for x, _, _ in parts[1:])
    return parts[-1][2], False


@pytest.fixture(scope="module")
def two_column_pdf(tmp_path_factory):
    return _two_column_pdf(str(tmp_path_factory.mktemp("cam") / "twocol.pdf"))


@pytest.mark.parametrize("size", [(1920, 1080), (1080, 1920), (1080, 1080)])
@pytest.mark.parametrize("animation", ["follow", "kenburns", "static"])
@pytest.mark.parametrize("book", ["sample", "twocol"])
def test_highlight_is_on_screen_while_read(size, animation, book, sample_pdf, two_column_pdf, tmp_path):
    pdf = sample_pdf if book == "sample" else two_column_pdf
    segs, sizes = _sentence_segments(pdf)
    W, H = size
    params = {"width": W, "height": H, "fps": FPS, "totalDuration": segs[-1]["end"] + 1,
              "chapter": {"title": "Chapter", "start": 0.0, "end": segs[-1]["end"] + 1},
              "pages": {str(s["page"]): sizes[str(s["page"])] for s in segs}, "segments": segs,
              "style": {"animation": animation, "showChapterTitle": False, "showProgress": False},
              "pdfPath": pdf, "pageDir": str(tmp_path / "pages")}
    params["pages"] = prepare_pages(params)
    comp = ChapterCompositor(params)
    tol = 2.0  # px
    off = []
    for i, s in enumerate(segs):
        for f in range(int(np.ceil(s["start"] * FPS)), int(s["end"] * FPS)):
            t = f / FPS
            reading, near_break = _reading_rects(s, t)
            page, rects = comp.frame_rects(t, reading)
            if page != s["page"] or near_break:  # still cross-fading from the previous page / column break
                continue
            for x0, y0, x1, y1 in rects:
                over = max(-x0, -y0, x1 - W, y1 - H)
                if over > tol:
                    off.append((i, round(t - s["start"], 2), round(over)))
                    break
    assert not off, f"{len(off)} frames show the sentence being read off-screen (seg, s after start, px): {off[:10]}"

    # And the real pixels: mid-sentence, the highlight is drawn and lies inside the frame.
    for s in segs[:: max(1, len(segs) // 8)]:
        t = (s["start"] + s["end"]) / 2
        page, rects = comp.frame_rects(t, _reading_rects(s, t)[0])
        frame = comp.frame(t).astype(np.int16)
        plain = comp.render_plain(t).astype(np.int16)
        ys, xs = np.nonzero(np.abs(frame - plain).sum(axis=2) > 12)
        assert xs.size > 0
        x0, y0 = min(r[0] for r in rects), min(r[1] for r in rects)
        x1, y1 = max(r[2] for r in rects), max(r[3] for r in rects)
        inside = (xs >= x0 - 12) & (xs <= x1 + 12) & (ys >= y0 - 12) & (ys <= y1 + 12)
        assert inside.mean() > 0.5

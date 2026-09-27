"""Word / cursor highlighting, page fit and the frame border."""
import numpy as np
import pytest

from audiobook_worker.pdf.render import render_pages_rpc
from audiobook_worker.video import layout
from audiobook_worker.video.compositor import ChapterCompositor, hex_to_bgr


class Ctx:
    def progress(self, *a, **k):
        pass


def words_seg(start, y, n=4, x0=60.0, w=40.0, gap=8.0, dur=0.5, page=2):
    """One sentence on one line: n words of width w, each spoken for dur seconds."""
    ws = [{"start": start + i * dur, "end": start + (i + 1) * dur, "rects": [[x0 + i * (w + gap), y, x0 + i * (w + gap) + w, y + 12]]}
          for i in range(n)]
    return {"start": start, "end": start + n * dur, "page": page, "rects": [[x0, y, ws[-1]["rects"][0][2], y + 12]], "words": ws}


# ─────────────────────────── layout math ───────────────────────────

def test_content_box_insets_by_scaled_border():
    assert layout.content_box(1920, 1080, {}) == (0, 0, 1920, 1080)
    assert layout.content_box(1920, 1080, {"frameStyle": "none", "frameWidth": 40}) == (0, 0, 1920, 1080)
    assert layout.content_box(1920, 1080, {"frameStyle": "solid", "frameWidth": 24}) == (24, 24, 1872, 1032)
    assert layout.content_box(3840, 2160, {"frameStyle": "solid", "frameWidth": 24}) == (48, 48, 3744, 2064)
    x, _, w, _ = layout.content_box(320, 180, {"frameStyle": "solid", "frameWidth": 500})
    assert x <= 36 and w > 0  # never eats the picture


def test_fit_scale():
    pw, ph, W, H = 432.0, 648.0, 1920, 1080
    assert layout.fit_scale(pw, ph, W, H, "follow", "width") == pytest.approx(W / pw)
    s_text = layout.fit_scale(pw, ph, W, H, "follow", "text", text_w=324.0)
    assert s_text > W / pw
    assert 324.0 * s_text == pytest.approx(W / (1 + 2 * layout.TEXT_PAD))
    # text wider than the page minus its margins: never zoom out past full width
    assert layout.fit_scale(pw, ph, W, H, "follow", "text", text_w=431.0) == pytest.approx(W / pw)
    assert layout.fit_scale(pw, ph, W, H, "static", "auto") == layout.base_scale(pw, ph, W, H, "static")


def test_text_extents_and_center():
    segs = [{"page": 2, "rects": [[72, 100, 360, 112], [90, 115, 300, 127]]}, {"page": 3, "rects": [[54, 100, 342, 112]]}]
    width, spans = layout.text_extents(segs)
    assert width == 288 and spans == {2: (72, 360), 3: (54, 342)}
    vis = 300.0
    # each page is centred on its own text column (left and right pages have different margins)
    assert layout.center_x(432, vis, "text", spans[2], width) == pytest.approx(72 + 144)
    assert layout.center_x(432, vis, "text", spans[3], width) == pytest.approx(54 + 144)
    # a page with one short centred line is centred on that line, and the camera stays on the page
    assert layout.center_x(432, vis, "text", (180, 250), width) == pytest.approx(215)
    assert layout.center_x(432, vis, "text", (0, 60), 288) == pytest.approx(vis / 2)
    assert layout.center_x(432, vis, "width", spans[2], width) == 216


def test_clamp_center_without_pad_keeps_page_edge_to_edge():
    assert layout.clamp_center(0, 800, 300, pad=0.0) == 150
    assert layout.clamp_center(800, 800, 300, pad=0.0) == 650
    assert layout.clamp_center(0, 800, 300) < 150  # default shows a little margin above the page


def test_word_marks_glide_on_a_line_and_fade_across_lines():
    s = words_seg(1.0, 100)
    segs = [s]
    w0, w1 = s["words"][0]["rects"][0], s["words"][1]["rects"][0]
    # the first word fades in (nothing to glide from)
    (rects, a), = layout.word_marks(segs, 0, 0, 1.0 + layout.HL_FADE_IN / 2)
    assert rects == [w0] and 0 < a < 1
    # half-way through the glide the box sits between the two words
    (rects, a), = layout.word_marks(segs, 0, 0, 1.5 + layout.GLIDE / 2)
    assert a == 1.0 and w0[0] < rects[0][0] < w1[0]
    (rects, a), = layout.word_marks(segs, 0, 0, 1.5 + layout.GLIDE + 0.01)
    assert rects == [w1]
    # next word on another line: cross-fade, no diagonal sweep
    s["words"][2]["rects"] = [[60, 130, 100, 142]]
    marks = layout.word_marks(segs, 0, 0, 2.0 + layout.GLIDE_FADE / 2)
    assert [m[0] for m in marks] == [[w1], [[60, 130, 100, 142]]]
    assert marks[0][1] + marks[1][1] == pytest.approx(1.0)
    # long pause after the sentence: the last word fades out like the sentence highlight
    assert layout.word_marks(segs, 0, 0, s["end"] + layout.HL_HOLD + layout.HL_FADE_OUT + 0.1)[0][1] == 0.0


def test_word_marks_glide_into_the_next_sentence():
    a, b = words_seg(1.0, 100, n=2), words_seg(2.3, 100, n=2, x0=160)
    (rects, al), = layout.word_marks([a, b], 0, 1, 2.3 + layout.GLIDE / 2)
    assert al == 1.0 and a["words"][-1]["rects"][0][0] < rects[0][0] < b["words"][0]["rects"][0][0]


def test_cursor_sweeps_continuously_through_the_line():
    s = words_seg(1.0, 100)
    xs = [layout.cursor_position(s, 1.0 + i * 0.01)[1] for i in range(201)]
    assert all(b >= a for a, b in zip(xs, xs[1:]))
    steps = np.diff(xs)
    assert steps.max() < 3.0  # no jumps: the space after a word is swept too
    assert xs[0] == pytest.approx(60) and xs[-1] == pytest.approx(s["rects"][0][2])


def test_cursor_moves_to_the_next_line_and_reports_read_rects():
    s = words_seg(1.0, 100, n=2)
    s["words"].append({"start": 2.0, "end": 2.5, "rects": [[60, 115, 120, 127]]})
    s["rects"].append([60, 115, 120, 127])
    s["end"] = 2.5
    assert layout.cursor_position(s, 1.9)[0] == 0
    line, x = layout.cursor_position(s, 2.25)
    assert line == 1 and x == pytest.approx(90)
    read, caret, a = layout.cursor_marks(s, 2.25)
    assert read == [s["rects"][0], [60, 115, 90, 127]] and caret == [90, 115, 90, 127] and a == 1.0
    read, caret, _ = layout.cursor_marks(s, 2.6)
    assert read[-1] == s["rects"][1] and caret is None  # finished: whole sentence read, no caret


# ─────────────────────────── compositor ───────────────────────────

@pytest.fixture()
def pages(sample_pdf, tmp_path):
    r = render_pages_rpc({"path": sample_pdf, "pages": [2], "scale": 2.0, "outDir": str(tmp_path / "pages")}, Ctx())
    return {"2": {"image": r["pages"][0]["path"], "scale": r["pages"][0]["scale"], "w": 432, "h": 648}}


def comp(pages, segs, **style):
    return ChapterCompositor({"width": 640, "height": 360, "fps": 30, "totalDuration": 10.0,
                              "chapter": {"title": "", "start": 0.0, "end": 10.0}, "pages": pages, "segments": segs,
                              "style": {"animation": "static", "showProgress": False, "showChapterTitle": False, **style}})


def changed(c, t):
    return np.abs(c.frame(t).astype(int) - c.render_plain(t).astype(int)).sum(axis=2) > 12


def test_defaults_render_exactly_as_before(pages):
    segs = [words_seg(1.0, 200)]
    a = comp(pages, [dict(s) for s in segs]).frame(1.6)
    b = comp(pages, [dict(s) for s in segs], highlightMode="sentence", pageFit="auto", frameStyle="none").frame(1.6)
    assert (a == b).all()


def test_word_mode_highlights_only_the_spoken_word(pages):
    segs = [words_seg(1.0, 200)]
    c = comp(pages, segs, highlightMode="word", sentenceTint=False)
    t = 1.5 + layout.GLIDE + 0.05  # second word, glide finished
    ys, xs = np.nonzero(changed(c, t))
    _, [(x0, _, x1, _)] = c.frame_rects(t, [segs[0]["words"][1]["rects"][0]])
    assert xs.size and xs.min() >= x0 - 6 and xs.max() <= x1 + 6
    # with the sentence tint the rest of the line is tinted too
    tinted = comp(pages, [words_seg(1.0, 200)], highlightMode="word")
    assert changed(tinted, t).sum() > changed(c, t).sum()


def test_cursor_mode_grows_through_the_sentence(pages):
    c = comp(pages, [words_seg(1.0, 200)], highlightMode="cursor", sentenceTint=False)
    areas = [changed(c, t).sum() for t in (1.3, 1.9, 2.6)]
    assert areas[0] < areas[1] < areas[2]


def test_word_mode_without_word_timings_falls_back_to_the_sentence(pages):
    s = words_seg(1.0, 200)
    del s["words"]
    assert changed(comp(pages, [s], highlightMode="word"), 1.5).sum() > 0


@pytest.mark.parametrize("kind", ["solid", "double", "dashed"])
def test_frame_border_is_drawn_around_the_picture(pages, kind):
    color = "#C0392B"
    c = comp(pages, [words_seg(1.0, 200)], frameStyle=kind, frameColor=color, frameWidth=30, frameRadius=24, showProgress=True)
    f = c.frame(1.5)
    b = c.ox
    assert b == 10 and (c.CW, c.CH) == (620, 340)
    bgr = np.array(hex_to_bgr(color))
    band = f[:b].reshape(-1, 3).astype(int)
    on = (np.abs(band - bgr).sum(axis=1) < 30).mean()
    if kind == "solid":
        assert on > 0.99
    elif kind == "double":
        assert 0.3 < on < 0.9 and (np.abs(f[b // 2, 320].astype(int) - np.array(c.bg)).sum() < 30)  # gap between the lines
    else:
        assert 0.3 < on < 0.9
    # rounded corner: the picture's own corner pixel belongs to the border, its centre does not
    assert np.abs(f[b, b].astype(int) - bgr).sum() < 90 or kind != "solid"
    assert np.abs(f[180, 320].astype(int) - bgr).sum() > 60
    # progress bar sits inside the picture, above the bottom border
    assert np.abs(f[360 - b - 2, 30].astype(int) - np.array(c.bg)).sum() > 0


def test_highlight_stays_inside_the_frame(pages):
    segs = [words_seg(1.0, 30 + 60 * i, page=2) for i in range(9)]
    for i, s in enumerate(segs):
        for w in s["words"]:
            w["start"] += i * 2.5
            w["end"] += i * 2.5
        s["start"], s["end"] = s["words"][0]["start"], s["words"][-1]["end"]
    c = comp(pages, segs, frameStyle="solid", frameWidth=30, pageFit="width", highlightMode="word")
    for s in segs:
        for w in s["words"]:
            t = (w["start"] + w["end"]) / 2
            _, [(x0, y0, x1, y1)] = c.frame_rects(t, w["rects"])
            assert x0 >= c.ox - 1 and x1 <= c.ox + c.CW + 1 and y0 >= c.oy - 1 and y1 <= c.oy + c.CH + 1

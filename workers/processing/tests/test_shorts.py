import json
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from audiobook_worker.shorts.render import Captions, ShortCompositor, font_for, render_short, wrap
from audiobook_worker.shorts.scenes import MOTIONS, SCENES


def words(text, t0=0.0, dt=0.3):
    out, t = [], t0
    for w in text.split():
        out.append({"t": w, "start": round(t, 3), "end": round(t + dt, 3)})
        t += dt
    return out


def groups_of(ws, n=3):
    return [{"start": ws[i]["start"], "end": ws[min(i + n, len(ws)) - 1]["end"], "words": ws[i:i + n]} for i in range(0, len(ws), n)]


LOOK = {"theme": "midnight", "captions": "karaoke", "accent": "#FACC15", "position": "center", "uppercase": True, "showTitle": True, "showProgress": True}


def params(tmp_path, **over):
    ws = words("A quiet postmaster in a small village learns about love.")
    p = {"width": 216, "height": 384, "fps": 10, "duration": 3.6, "title": "The Postmaster", "language": "en",
         "look": dict(LOOK), "groups": groups_of(ws), "outPath": str(tmp_path / "short.mp4"),
         "encoder": {"codec": "auto", "bitrate": "1M"}}
    p.update(over)
    return p


def test_spoken_word_is_highlighted_and_captions_change(tmp_path):
    comp = ShortCompositor(params(tmp_path))
    first, second = comp.frame(0.05), comp.frame(0.35)  # word 1 vs word 2 of the first card
    assert first.shape == (384, 216, 3)
    assert np.abs(first.astype(int) - second.astype(int)).sum() > 0
    accent = np.array([21, 204, 250])  # BGR of #FACC15
    assert (np.abs(first.astype(int) - accent).sum(axis=2) < 60).sum() > 20  # accent-coloured text on screen


def test_plain_style_has_no_highlight_and_paper_uses_a_box(tmp_path):
    p = params(tmp_path)
    p["look"] = {**LOOK, "captions": "plain"}
    comp = ShortCompositor(p)
    assert np.array_equal(comp.captions.patch(0, comp.captions.active_word(0, 0.05)).col, comp.captions.patch(0, -1).col)
    caps = Captions(p["groups"], 1080, 1920, {**LOOK, "theme": "paper"}, 960, "en")
    assert caps.style == "box"


def test_two_lines_are_balanced():
    font = font_for("WHAT IF ONE QUIET", "caption", 92)
    lines = wrap("WHAT IF ONE QUIET".split(), font, 700)
    assert [len(l) for l in lines] == [2, 2]


def test_bangla_caption_renders(tmp_path):
    ws = words("একটি ছোট্ট গ্রামের পোস্টমাস্টার")
    p = params(tmp_path, language="bn", groups=groups_of(ws, 4), title="পোস্টমাস্টার")
    comp = ShortCompositor(p)
    patch = comp.captions.patch(0, 1)
    assert patch.col.shape[1] > 20 and patch.col.shape[0] > 10


def test_cover_theme_falls_back_without_a_cover(tmp_path):
    p = params(tmp_path)
    p["look"] = {**LOOK, "theme": "cover"}
    p["coverPath"] = str(tmp_path / "missing.jpg")
    comp = ShortCompositor(p)  # no crash: gradient instead
    assert comp.zoom_bg is None


def test_cover_theme_draws_the_cover(tmp_path):
    cover = tmp_path / "cover.jpg"
    Image.new("RGB", (300, 450), (200, 30, 30)).save(cover)
    p = params(tmp_path, coverPath=str(cover))
    p["look"] = {**LOOK, "theme": "cover"}
    comp = ShortCompositor(p)
    f0, f1 = comp.frame(0.0), comp.frame(3.5)
    assert comp.zoom_bg is not None
    assert (f0[..., 2] > 150).sum() > 500  # the red card is visible
    assert not np.array_equal(f0, f1)  # slow zoom + progress


@pytest.mark.parametrize("theme", sorted(SCENES))
def test_animated_backgrounds_move_and_are_repeatable(tmp_path, theme):
    p = params(tmp_path, groups=[])
    p["look"] = {**LOOK, "theme": theme, "showProgress": False}
    comp = ShortCompositor(p)
    a, b = comp.frame(0.5), comp.frame(2.0)
    assert comp.scene is not None and a.shape == (384, 216, 3) and a.dtype == np.uint8
    assert np.abs(a.astype(int) - b.astype(int)).mean() > 0.2  # it moves
    assert np.array_equal(comp.frame(0.5), ShortCompositor(p).frame(0.5))  # a pure, seeded function of time
    assert a[:, :, :].mean() > 8  # not a black frame


@pytest.mark.parametrize("motion", sorted(MOTIONS))
@pytest.mark.parametrize("theme", ["midnight", "paper"])
def test_motion_overlays_move_over_any_background(tmp_path, motion, theme):
    p = params(tmp_path, groups=[])
    p["look"] = {**LOOK, "theme": theme, "motion": motion, "showProgress": False}
    comp = ShortCompositor(p)
    still = dict(p, look={**p["look"], "motion": None})
    plain = ShortCompositor(still).frame(1.0)
    frames = [comp.frame(t) for t in (0.4, 1.0, 1.7)]
    assert comp.motion is not None and comp.statics  # the title stays on top, drawn after the particles
    assert np.abs(frames[1].astype(int) - plain.astype(int)).sum() > 0  # particles are visible
    assert np.abs(frames[0].astype(int) - frames[2].astype(int)).sum() > 0  # and they move


def test_motion_over_the_cover(tmp_path):
    cover = tmp_path / "cover.jpg"
    Image.new("RGB", (300, 450), (200, 30, 30)).save(cover)
    p = params(tmp_path, coverPath=str(cover))
    p["look"] = {**LOOK, "theme": "cover", "motion": "embers"}
    comp = ShortCompositor(p)
    assert comp.zoom_bg is not None and comp.motion is not None
    assert (comp.frame(1.0)[..., 2] > 150).sum() > 500  # the card is still drawn


def test_unknown_theme_and_motion_fall_back(tmp_path):
    p = params(tmp_path)
    p["look"] = {**LOOK, "theme": "nope", "motion": "nope"}
    comp = ShortCompositor(p)
    assert comp.scene is None and comp.motion is None and comp.base is not None


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_render_short_writes_a_vertical_video(tmp_path):
    class Ctx:
        calls = 0

        def progress(self, *a, **k):
            Ctx.calls += 1

    r = render_short(params(tmp_path), Ctx())
    assert r["frames"] == 36 and Ctx.calls > 0
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,nb_frames", "-of", "json", r["path"]],
                           capture_output=True, text=True, check=True)
    s = json.loads(probe.stdout)["streams"][0]
    assert (s["width"], s["height"]) == (216, 384)


def test_thumbnail_opens_the_video_and_fades_into_the_captions(tmp_path):
    thumb = tmp_path / "thumbnail.jpg"
    Image.new("RGB", (540, 960), (10, 200, 60)).save(thumb)
    comp = ShortCompositor(params(tmp_path, introPath=str(thumb)))
    first, mid, after = comp.frame(0.0), comp.frame(0.21), comp.frame(0.3)
    assert abs(int(first[192, 108, 1]) - 200) < 12 and first[192, 108, 2] < 30  # the green thumbnail, full frame
    assert 0 < np.abs(mid.astype(int) - first.astype(int)).mean()  # fading out
    assert not (abs(int(after[192, 108, 1]) - 200) < 12 and after[192, 108, 2] < 30)  # the short itself
    assert ShortCompositor(params(tmp_path, introPath=str(tmp_path / "missing.jpg"))).intro is None

import json
import shutil
import subprocess

import numpy as np
import pytest

from audiobook_worker.pdf.render import render_pages_rpc
from audiobook_worker.video.compositor import ChapterCompositor
from audiobook_worker.video.render_chapter import render_chapter

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


class Ctx:
    def progress(self, *a, **k):
        pass


def _params(sample_pdf, tmp_path, fps=10, animation="follow"):
    r = render_pages_rpc({"path": sample_pdf, "pages": [2, 3], "scale": 1.2, "outDir": str(tmp_path / "pages")}, Ctx())
    pages = {str(p["page"]): {"image": p["path"], "scale": p["scale"], "w": 432, "h": 648} for p in r["pages"]}
    segs = [
        {"start": 0.2, "end": 1.0, "page": 2, "rects": [[54, 120, 378, 132]]},
        {"start": 1.2, "end": 2.0, "page": 2, "rects": [[54, 400, 378, 412], [54, 415, 200, 427]]},
        {"start": 2.3, "end": 3.0, "page": 3, "rects": [[54, 100, 378, 112]]},
    ]
    return {"width": 320, "height": 180, "fps": fps, "frameStart": 0, "frameEnd": 32, "totalDuration": 3.2,
            "chapter": {"title": "Chapter 1: The Beginning", "start": 0.0, "end": 3.2},
            "pages": pages, "segments": segs,
            "style": {"animation": animation, "highlightStyle": "marker", "highlightColor": "#FFD54F"},
            "encoder": {"codec": "auto", "bitrate": "1M"}, "outPath": str(tmp_path / "seg.mp4")}


def test_highlight_changes_pixels(sample_pdf, tmp_path):
    p = _params(sample_pdf, tmp_path, animation="static")
    p["style"]["showProgress"] = False
    p["style"]["showChapterTitle"] = False
    comp = ChapterCompositor(p)
    before = comp.frame(0.1).copy()
    during = comp.frame(0.6).copy()
    assert before.shape == (180, 320, 3)
    assert np.abs(during.astype(int) - before.astype(int)).sum() > 0


def test_render_segment_frame_count(sample_pdf, tmp_path):
    p = _params(sample_pdf, tmp_path)
    res = render_chapter(p, Ctx())
    assert res["frames"] == 32
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                            "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", res["path"]],
                           capture_output=True, text=True, check=True)
    st = json.loads(probe.stdout)["streams"][0]
    assert int(st["nb_read_frames"]) == 32
    assert (st["width"], st["height"]) == (320, 180)


def test_on_demand_page_rendering(sample_pdf, tmp_path):
    p = _params(sample_pdf, tmp_path)
    p["pages"] = {"2": {"w": 432, "h": 648}, "3": {"w": 432, "h": 648}}
    p["pdfPath"] = sample_pdf
    p["pageDir"] = str(tmp_path / "cache")
    p["outPath"] = str(tmp_path / "seg2.mp4")
    res = render_chapter(p, Ctx())
    assert res["frames"] == 32
    assert len(list((tmp_path / "cache").rglob("page-*.png"))) == 2

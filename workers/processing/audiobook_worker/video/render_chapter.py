"""Render one chapter's video segment (video only; audio is muxed once at the end).

Pages are rasterized on demand at exactly the resolution the camera needs
(base scale × max zoom), cached on disk and shared between chapters.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from ..errors import WorkerError
from ..pdf.common import open_pdf
from ..pdf.render import effective_scale, render_page
from ..util import atomic_path
from . import layout
from .compositor import ChapterCompositor
from .encoder import FrameWriter

MAX_ZOOM = 1.07
STALE_TMP_SECONDS = 3600


def sweep_stale_temp(directory: str | os.PathLike, max_age: float = STALE_TMP_SECONDS) -> None:
    """Remove temp segments of renders that died: a cancelled job SIGKILLs the worker, so
    atomic_path never cleans up and ffmpeg finishes a partial `.<key>.mp4.<rand>.mp4`.
    A live render writes continuously, so only files untouched for `max_age` are removed."""
    now = time.time()
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for e in entries:
        n = e.name
        if not (n.startswith(".") and ".mp4." in n and n.endswith((".mp4", ".mp4.log"))):
            continue
        try:
            if e.is_file() and now - e.stat().st_mtime > max_age:
                os.unlink(e.path)
        except OSError:
            pass


def page_render_scale(w: float, h: float, W: int, H: int, animation: str) -> float:
    s = layout.base_scale(w, h, W, H, animation) * MAX_ZOOM
    return round(s * 20) / 20  # quantize so neighbouring chapters share page images


def prepare_pages(params: dict, ctx=None) -> dict:
    """Ensure every page used by the segments is rendered. Returns compositor `pages` mapping."""
    if all("image" in v for v in params["pages"].values()):
        return params["pages"]
    W, H = int(params["width"]), int(params["height"])
    animation = params.get("style", {}).get("animation", "follow")
    page_dir = Path(params["pageDir"])
    needed = sorted({int(s["page"]) for s in params["segments"]})
    out: dict[str, dict] = {}
    doc = open_pdf(params["pdfPath"], params.get("password"))
    try:
        for i, p in enumerate(needed):
            size = params["pages"][str(p)]
            w, h = float(size["w"]), float(size["h"])
            scale = page_render_scale(w, h, W, H, animation)
            img = page_dir / f"{scale:.2f}" / f"page-{p:04d}.png"
            if not img.exists():
                scale = render_page(doc, p, scale, str(img))["scale"]
            else:  # cached image: report the scale it was really rendered at (MAX_PIXELS may have capped it)
                scale = effective_scale(doc[p - 1], scale)
            out[str(p)] = {"image": str(img), "scale": scale, "w": w, "h": h}
            if ctx:
                ctx.progress(i + 1, len(needed), None, phase="pages")
    finally:
        doc.close()
    return out


def render_chapter(params: dict, ctx=None) -> dict:
    fps = int(params["fps"])
    f0, f1 = int(params["frameStart"]), int(params["frameEnd"])
    if f1 <= f0:
        raise WorkerError("VIDEO_EMPTY_SEGMENT", "Chapter has no duration to render.")
    if not params.get("segments"):
        raise WorkerError("VIDEO_NO_SEGMENTS", "Chapter has no narrated sentences to show.")
    params = {**params, "pages": prepare_pages(params, ctx)}
    comp = ChapterCompositor(params)
    enc = params.get("encoder", {})
    out_path = params["outPath"]
    sweep_stale_temp(os.path.dirname(os.path.abspath(out_path)))
    started = time.monotonic()
    with atomic_path(out_path) as tmp:
        writer = FrameWriter(tmp, comp.W, comp.H, fps, enc.get("codec", "auto"), enc.get("bitrate", "6M"),
                             int(enc.get("crf", 20)), enc.get("ffmpeg", "ffmpeg"))
        try:
            total = f1 - f0
            for i, f in enumerate(range(f0, f1)):
                writer.write(comp.frame(f / fps).data)
                if ctx and (i % 15 == 0 or i == total - 1):
                    ctx.progress(i + 1, total, None, phase="frames")
            writer.close()
        except BaseException:
            writer.abort()
            raise
    elapsed = time.monotonic() - started
    return {"path": out_path, "frames": f1 - f0, "codec": writer.codec, "renderSeconds": round(elapsed, 2),
            "fpsAchieved": round((f1 - f0) / max(elapsed, 1e-6), 1), "size": os.path.getsize(out_path)}


def render_chapter_rpc(params: dict, ctx) -> dict:
    return render_chapter(params, ctx)

"""Frame compositor: page image + highlight + camera + overlays → BGR frames.

Memory: at most a few page canvases (~8MB each) are held at once (LRU).
Speed: a frame is one cv2.warpAffine of the output size plus small overlay blends;
identical consecutive frames are detected and reused without recomputation.
"""
from __future__ import annotations

import os
from collections import OrderedDict
from dataclasses import dataclass

import cv2
import numpy as np

from . import layout

THEMES = {
    # background, card, card_text, progress_track  (RGB)
    "paper": ((236, 230, 218), (255, 255, 255), (40, 38, 34), (0, 0, 0)),
    "light": ((243, 244, 246), (255, 255, 255), (17, 24, 39), (0, 0, 0)),
    "dark": ((17, 19, 24), (32, 35, 42), (240, 240, 245), (255, 255, 255)),
}

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def hex_to_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return b, g, r


def rgb_to_bgr(c):
    return c[2], c[1], c[0]


@dataclass
class PageAsset:
    image: str
    scale: float  # image pixels per PDF point
    w: float      # page width in points
    h: float


class PageCanvas:
    """A page image on a margin with a soft drop shadow."""

    def __init__(self, asset: PageAsset, bg_bgr):
        img = cv2.imread(asset.image, cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(asset.image)
        self.rs = asset.scale
        self.margin = m = int(max(img.shape[1], img.shape[0]) * 0.06)
        h, w = img.shape[:2]
        canvas = np.empty((h + 2 * m, w + 2 * m, 3), dtype=np.uint8)
        canvas[:] = bg_bgr
        # soft shadow
        shadow = np.zeros(canvas.shape[:2], dtype=np.float32)
        off = max(2, int(m * 0.12))
        shadow[m + off:m + h + off, m + off // 2:m + w + off // 2] = 1.0
        k = max(3, int(m * 0.5) | 1)
        shadow = cv2.GaussianBlur(shadow, (k, k), 0) * 0.28
        canvas = (canvas.astype(np.float32) * (1.0 - shadow[..., None])).astype(np.uint8)
        canvas[m:m + h, m:m + w] = img
        self.base = canvas

    def to_px(self, r) -> tuple[int, int, int, int]:
        m, s = self.margin, self.rs
        return (int(m + r[0] * s), int(m + r[1] * s), int(np.ceil(m + r[2] * s)), int(np.ceil(m + r[3] * s)))


class ChapterCompositor:
    def __init__(self, params: dict):
        self.W = int(params["width"])
        self.H = int(params["height"])
        self.fps = int(params["fps"])
        st = params.get("style", {})
        self.animation = st.get("animation", "follow")
        self.subtle_zoom = bool(st.get("subtleZoom", True)) and self.animation != "static"
        self.hl_style = st.get("highlightStyle", "marker")
        self.hl_color = np.array(hex_to_bgr(st.get("highlightColor", "#FFD54F")), dtype=np.float32)
        theme = THEMES.get(st.get("theme", "paper"), THEMES["paper"])
        self.bg = rgb_to_bgr(theme[0])
        self.card_bg = rgb_to_bgr(theme[1])
        self.card_fg = theme[2]  # RGB for PIL
        self.track = rgb_to_bgr(theme[3])
        self.show_progress = bool(st.get("showProgress", True))
        self.show_title = bool(st.get("showChapterTitle", True))
        self.total = max(0.001, float(params.get("totalDuration", 1.0)))
        ch = params.get("chapter", {})
        self.ch_title = ch.get("title") or ""
        self.ch_start = float(ch.get("start", 0.0))
        self.ch_end = float(ch.get("end", 0.0))
        self.pages = {int(k): PageAsset(**v) for k, v in params["pages"].items()}
        self.segments = sorted(params["segments"], key=lambda s: s["start"])
        self.runs = layout.build_runs(self.segments, self.ch_start, self.ch_end)
        self._canvas_cache: OrderedDict[int, PageCanvas] = OrderedDict()
        self._comp_cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._paths: dict[int, layout.CameraPath] = {}
        self._run_scale: dict[int, float] = {}
        self.ui = min(self.W, self.H) / 1080.0
        self._title_img = self._render_title() if self.show_title and self.ch_title else None
        self._last_key = None
        self._last_frame: np.ndarray | None = None
        for j, r in enumerate(self.runs):
            a = self.pages[r.page]
            s = layout.base_scale(a.w, a.h, self.W, self.H, self.animation)
            self._run_scale[j] = s
            segs = self.segments[r.seg_from:r.seg_to]
            self._paths[j] = layout.build_camera_path(segs, a.h, self.H / s, r.show_from, self.animation == "follow")

    # ── caches ──────────────────────────────────────────────
    def _canvas(self, page: int) -> PageCanvas:
        c = self._canvas_cache.get(page)
        if c is None:
            c = PageCanvas(self.pages[page], self.bg)
            self._canvas_cache[page] = c
            while len(self._canvas_cache) > 3:
                self._canvas_cache.popitem(last=False)
        else:
            self._canvas_cache.move_to_end(page)
        return c

    def _composite(self, page: int, hl: tuple) -> np.ndarray:
        """Page canvas with highlights. hl = ((seg_idx, alpha_q), ...)"""
        key = (page, hl)
        img = self._comp_cache.get(key)
        if img is not None:
            self._comp_cache.move_to_end(key)
            return img
        canvas = self._canvas(page)
        img = canvas.base.copy() if hl else canvas.base
        for seg_idx, aq in hl:
            a = aq / 16.0
            if a <= 0:
                continue
            for r in self.segments[seg_idx]["rects"]:
                self._draw_highlight(img, canvas, r, a)
        self._comp_cache[key] = img
        while len(self._comp_cache) > 4:
            self._comp_cache.popitem(last=False)
        return img

    def _draw_highlight(self, img: np.ndarray, canvas: PageCanvas, r, a: float) -> None:
        x0, y0, x1, y1 = canvas.to_px(r)
        padx = max(2, int((y1 - y0) * 0.18))
        pady = max(1, int((y1 - y0) * 0.08))
        x0, y0 = max(0, x0 - padx), max(0, y0 - pady)
        x1, y1 = min(img.shape[1], x1 + padx), min(img.shape[0], y1 + pady)
        if x1 <= x0 or y1 <= y0:
            return
        roi = img[y0:y1, x0:x1].astype(np.float32)
        col = self.hl_color
        if self.hl_style == "underline":
            th = max(2, int((y1 - y0) * 0.12))
            band = roi[-th:]
            roi[-th:] = band * (1 - a) + col * a
        elif self.hl_style == "box":
            roi[:] = roi * (1 - 0.18 * a) + col * (0.18 * a)
            th = max(1, int((y1 - y0) * 0.06))
            for sl in (np.s_[:th, :], np.s_[-th:, :], np.s_[:, :th], np.s_[:, -th:]):
                roi[sl] = roi[sl] * (1 - a) + col * a
        else:  # marker: multiply blend — dark ink stays dark, paper takes the marker color
            mult = 1.0 - a * (1.0 - col / 255.0)
            roi *= mult
        img[y0:y1, x0:x1] = np.clip(roi, 0, 255).astype(np.uint8)

    def _render_title(self) -> np.ndarray | None:
        from PIL import Image, ImageDraw, ImageFont

        size = int(30 * self.ui)
        font = None
        for f in FONT_CANDIDATES:
            if os.path.exists(f):
                try:
                    font = ImageFont.truetype(f, size)
                    break
                except OSError:
                    continue
        if font is None:
            font = ImageFont.load_default(size=size)
        text = self.ch_title if len(self.ch_title) <= 70 else self.ch_title[:67] + "…"
        tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        l, t, r, b = tmp.textbbox((0, 0), text, font=font)
        padx, pady = int(26 * self.ui), int(16 * self.ui)
        w, h = (r - l) + 2 * padx, (b - t) + 2 * pady
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        cb = self.card_bg[::-1]
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=int(14 * self.ui), fill=(*cb, 235))
        d.text((padx - l, pady - t), text, font=font, fill=(*self.card_fg, 255))
        arr = np.array(img)  # RGBA
        bgra = arr[..., [2, 1, 0, 3]].astype(np.float32)
        return bgra

    # ── per frame ───────────────────────────────────────────
    def _run_index(self, t: float) -> int:
        # runs are few per chapter; linear scan from last is fine
        for j in range(len(self.runs) - 1, -1, -1):
            if t >= self.runs[j].show_from:
                return j
        return 0

    def _run_state(self, j: int, t: float) -> tuple:
        r = self.runs[j]
        a = self.pages[r.page]
        s = self._run_scale[j]
        span = max(0.5, r.show_to - r.show_from)
        u = min(1.0, max(0.0, (t - r.show_from) / span))
        if self.animation == "kenburns":
            zoom = 1.0 + 0.06 * layout.smoothstep(u) if self.subtle_zoom else 1.0
        elif self.animation == "follow" and self.subtle_zoom:
            zoom = 1.0 + 0.03 * u
        else:
            zoom = 1.0
        cy = self._paths[j].y_at(t) if self.animation == "follow" else a.h / 2
        cur, ca, prev, pa = layout.highlight_state(self.segments, r.seg_from, r.seg_to, t)
        hl = []
        if prev is not None and pa > 0:
            hl.append((prev, int(round(pa * 16))))
        if cur is not None and ca > 0:
            hl.append((cur, int(round(ca * 16))))
        return (r.page, round(cy, 2), round(s * zoom, 5), tuple(hl))

    def _render_run(self, state: tuple) -> np.ndarray:
        page, cy, s, hl = state
        a = self.pages[page]
        canvas = self._canvas(page)
        img = self._composite(page, hl)
        k = s / canvas.rs
        cx = a.w / 2
        tx = self.W / 2 - (canvas.margin + cx * canvas.rs) * k
        ty = self.H / 2 - (canvas.margin + cy * canvas.rs) * k
        M = np.array([[k, 0, tx], [0, k, ty]], dtype=np.float32)
        interp = cv2.INTER_AREA if k < 0.8 else cv2.INTER_LINEAR
        return cv2.warpAffine(img, M, (self.W, self.H), flags=interp, borderMode=cv2.BORDER_CONSTANT, borderValue=self.bg)

    def frame(self, t: float) -> np.ndarray:
        j = self._run_index(t)
        st = self._run_state(j, t)
        fade = None
        if j > 0 and t < self.runs[j].show_from + layout.PAGE_FADE:
            fa = (t - self.runs[j].show_from) / layout.PAGE_FADE
            fade = (self._run_state(j - 1, t), int(round(layout.smoothstep(fa) * 32)))
        prog_px = int(self.W * min(1.0, t / self.total)) if self.show_progress else -1
        title_a = self._title_alpha(t)
        key = (st, fade, prog_px, int(title_a * 32))
        if key == self._last_key and self._last_frame is not None:
            return self._last_frame
        out = self._render_run(st)
        if fade is not None:
            old = self._render_run(fade[0])
            a = fade[1] / 32.0
            out = cv2.addWeighted(out, a, old, 1.0 - a, 0.0)
        if title_a > 0 and self._title_img is not None:
            self._blend_title(out, title_a)
        if prog_px >= 0:
            self._draw_progress(out, prog_px)
        self._last_key, self._last_frame = key, out
        return out

    # ── geometry (tests / diagnostics) ──────────────────────
    def frame_rects(self, t: float, rects) -> tuple[int, list[tuple[float, float, float, float]]]:
        """Page-space rects → frame pixel rects for the page on screen at time t: (page, rects)."""
        page, cy, s, _ = self._run_state(self._run_index(t), t)
        cx = self.pages[page].w / 2
        return page, [(self.W / 2 + (r[0] - cx) * s, self.H / 2 + (r[1] - cy) * s,
                       self.W / 2 + (r[2] - cx) * s, self.H / 2 + (r[3] - cy) * s) for r in rects]

    def render_plain(self, t: float) -> np.ndarray:
        """The page as framed at time t, without highlights, cross-fade or overlays."""
        page, cy, s, _ = self._run_state(self._run_index(t), t)
        return self._render_run((page, cy, s, ()))

    def _title_alpha(self, t: float) -> float:
        if self._title_img is None:
            return 0.0
        t0, t1, f = self.ch_start + 0.3, self.ch_start + 5.3, 0.4
        if t < t0 or t > t1:
            return 0.0
        return min(1.0, (t - t0) / f, (t1 - t) / f)

    def _blend_title(self, out: np.ndarray, a: float) -> None:
        img = self._title_img
        h, w = img.shape[:2]
        x, y = int(40 * self.ui), int(36 * self.ui)
        w, h = min(w, self.W - x), min(h, self.H - y)
        roi = out[y:y + h, x:x + w].astype(np.float32)
        src = img[:h, :w]
        al = src[..., 3:4] / 255.0 * a
        out[y:y + h, x:x + w] = (roi * (1 - al) + src[..., :3] * al).astype(np.uint8)

    def _draw_progress(self, out: np.ndarray, px: int) -> None:
        th = max(4, int(6 * self.ui))
        band = out[self.H - th:, :].astype(np.float32)
        band[:] = band * 0.82 + np.array(self.track, dtype=np.float32) * 0.18
        if px > 0:
            band[:, :px] = band[:, :px] * 0.1 + self.hl_color * 0.9
        out[self.H - th:, :] = band.astype(np.uint8)

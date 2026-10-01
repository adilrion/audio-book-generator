"""Frame compositor: page image + highlight + camera + overlays → BGR frames.

Memory: at most a few page canvases (~8MB each) are held at once (LRU).
Speed: a frame is one cv2.warpAffine of the output size plus small overlay blends;
identical consecutive frames are detected and reused without recomputation.
"""
from __future__ import annotations

import os
import re
from collections import OrderedDict
from dataclasses import dataclass

import cv2
import numpy as np

# Measured: single-threaded OpenCV renders as fast as multi-threaded (the frame loop is the
# bottleneck) with a third less CPU. The power mode can raise it via RENDER_THREADS.
cv2.setNumThreads(max(1, int(os.environ.get("RENDER_THREADS", "1") or 1)))

from . import layout

THEMES = {
    # background, card, card_text, progress_track  (RGB)
    "paper": ((236, 230, 218), (255, 255, 255), (40, 38, 34), (0, 0, 0)),
    "light": ((243, 244, 246), (255, 255, 255), (17, 24, 39), (0, 0, 0)),
    "dark": ((17, 19, 24), (32, 35, 42), (240, 240, 245), (255, 255, 255)),
}

TINT = 0.3  # strength of the sentence tint under a word / cursor highlight

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
# Fonts with Bangla glyphs (they cover Latin letters and digits too). Pillow shapes the conjuncts
# and vowel signs with libraqm.
BANGLA_FONT_CANDIDATES = [
    "/System/Library/Fonts/KohinoorBangla.ttc",
    "/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc",
    "/System/Library/Fonts/Supplemental/Bangla MN.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansBengali-Regular.ttf",
]
_BENGALI = re.compile(r"[\u0980-\u09ff]")


def title_font_candidates(text: str) -> list[str]:
    return BANGLA_FONT_CANDIDATES + FONT_CANDIDATES if _BENGALI.search(text) else FONT_CANDIDATES


def shorten(text: str, limit: int = 70) -> str:
    """Cut a long title at a word boundary, so a Bangla vowel sign is never cut off its letter."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 3]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:-—") + "…"


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


class FrameBorder:
    """Border around the picture: solid, double or dashed, with optionally rounded inner corners.

    Drawn once into a full-frame template from a signed distance to the (rounded) picture box, so
    edges and curves are anti-aliased. Per frame only the border bands are copied and the four
    corner patches blended — the picture inside is never touched.
    """

    def __init__(self, W: int, H: int, box: tuple[int, int, int, int], style: dict, bg_bgr) -> None:
        x, y, w, h = box
        b = x
        ui = min(W, H) / 1080.0
        r = min(float(style.get("frameRadius", 0)) * ui, min(w, h) / 2)
        color = np.array(hex_to_bgr(style.get("frameColor", "#1F2937")), dtype=np.float32)
        bg = np.array(bg_bgr, dtype=np.float32)
        py, px = np.mgrid[0:H, 0:W].astype(np.float32) + 0.5
        # signed distance to the picture box (negative inside)
        qx = np.abs(px - (x + w / 2)) - (w / 2 - r)
        qy = np.abs(py - (y + h / 2)) - (h / 2 - r)
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
        cover = np.clip(d + 0.5, 0.0, 1.0)  # how much of each pixel is border
        kind = style.get("frameStyle", "solid")
        if kind == "double":
            lw = max(1.0, b / 3.0)
            edge = np.minimum(np.minimum(px, W - px), np.minimum(py, H - py))  # distance to the frame edge
            ink = np.maximum(np.clip(lw - edge + 0.5, 0, 1), np.clip(lw - d + 0.5, 0, 1))
        elif kind == "dashed":
            ink = self._dashes(W, H, b, px, py)
        else:
            ink = np.ones((H, W), dtype=np.float32)
        tmpl = bg * (1 - ink[..., None]) + color * ink[..., None]
        self.template = np.clip(tmpl, 0, 255).astype(np.uint8)
        self.b = b
        self.bands = [np.s_[:b, :], np.s_[H - b:, :], np.s_[b:H - b, :b], np.s_[b:H - b, W - b:]]
        # Rounded corners reach into the picture box: blend those patches by coverage.
        n = int(np.ceil(r)) + 1
        self.patches = []
        if r > 0:
            for ys in (np.s_[y:y + n], np.s_[y + h - n:y + h]):
                for xs in (np.s_[x:x + n], np.s_[x + w - n:x + w]):
                    a = cover[ys, xs]
                    if a.max() > 0:
                        self.patches.append(((ys, xs), a[..., None]))

    @staticmethod
    def _dashes(W: int, H: int, b: int, px: np.ndarray, py: np.ndarray) -> np.ndarray:
        """Dashes three border-widths long, gaps two, fitted so every edge starts and ends on a dash
        at the corners (like CSS)."""
        def along(pos: np.ndarray, length: float) -> np.ndarray:
            period = 5.0 * b
            n = max(1, int(round((length - 3.0 * b) / period)))
            period = (length - 3.0 * b) / n if length > 3.0 * b else length
            return (np.mod(pos, period) < 3.0 * b).astype(np.float32)
        horiz = np.minimum(py, H - py) <= np.minimum(px, W - px)  # nearest edge is top/bottom
        return np.where(horiz, along(px, W), along(py, H))

    def apply(self, out: np.ndarray) -> None:
        t = self.template
        for sl in self.bands:
            out[sl] = t[sl]
        for sl, a in self.patches:
            out[sl] = (out[sl].astype(np.float32) * (1 - a) + t[sl].astype(np.float32) * a).astype(np.uint8)


class ChapterCompositor:
    def __init__(self, params: dict):
        self.W = int(params["width"])
        self.H = int(params["height"])
        self.fps = int(params["fps"])
        st = params.get("style", {})
        self.animation = st.get("animation", "follow")
        self.subtle_zoom = bool(st.get("subtleZoom", True)) and self.animation != "static"
        self.hl_mode = st.get("highlightMode", "sentence")
        self.hl_style = st.get("highlightStyle", "marker")
        self.hl_color = np.array(hex_to_bgr(st.get("highlightColor", "#FFD54F")), dtype=np.float32)
        self.tint = bool(st.get("sentenceTint", True))
        self.fit = st.get("pageFit", "auto")
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
        # Word and cursor modes draw on the finished frame (they move every frame); a segment
        # without word timings falls back to the sentence highlight.
        self.frame_marks = self.hl_mode in ("word", "cursor")
        self.runs = layout.build_runs(self.segments, self.ch_start, self.ch_end)
        # The picture sits inside the frame border; all layout happens in that box.
        self.ox, self.oy, self.CW, self.CH = layout.content_box(self.W, self.H, st)
        self._frame = FrameBorder(self.W, self.H, (self.ox, self.oy, self.CW, self.CH), st, self.bg) if st.get("frameStyle", "none") != "none" else None
        # A page larger than the frame must follow the narration, whatever the camera style.
        self.follow = self.animation == "follow" or self.fit != "auto"
        pad = 0.04 if self.fit == "auto" else 0.0  # edge to edge: never show past the page's top/bottom
        text_w, spans = layout.text_extents(self.segments) if self.fit == "text" else (0.0, {})
        self._canvas_cache: OrderedDict[int, PageCanvas] = OrderedDict()
        self._comp_cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._paths: dict[int, layout.CameraPath] = {}
        self._run_scale: dict[int, float] = {}
        self._run_cx: dict[int, float] = {}
        self.ui = min(self.W, self.H) / 1080.0
        self._title_img = self._render_title() if self.show_title and self.ch_title else None
        self._last_key = None
        self._last_frame: np.ndarray | None = None
        for j, r in enumerate(self.runs):
            a = self.pages[r.page]
            s = layout.fit_scale(a.w, a.h, self.CW, self.CH, self.animation, self.fit, text_w)
            self._run_scale[j] = s
            self._run_cx[j] = layout.center_x(a.w, self.CW / s, self.fit, spans.get(r.page), text_w)
            segs = self.segments[r.seg_from:r.seg_to]
            self._paths[j] = layout.build_camera_path(segs, a.h, self.CH / s, r.show_from, self.follow, pad)

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
        self._paint(img, *canvas.to_px(r), a)

    def _paint(self, img: np.ndarray, x0: int, y0: int, x1: int, y1: int, a: float, style: str | None = None) -> None:
        """Highlight the pixel box of one printed line piece (padded around the glyphs)."""
        style = style or self.hl_style
        padx = max(2, int((y1 - y0) * 0.18))
        pady = max(1, int((y1 - y0) * 0.08))
        x0, y0 = max(0, x0 - padx), max(0, y0 - pady)
        x1, y1 = min(img.shape[1], x1 + padx), min(img.shape[0], y1 + pady)
        if x1 <= x0 or y1 <= y0:
            return
        roi = img[y0:y1, x0:x1].astype(np.float32)
        col = self.hl_color
        if style == "underline":
            th = max(2, int((y1 - y0) * 0.12))
            band = roi[-th:]
            roi[-th:] = band * (1 - a) + col * a
        elif style == "box":
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
        for f in title_font_candidates(self.ch_title):
            if os.path.exists(f):
                try:
                    font = ImageFont.truetype(f, size)
                    break
                except OSError:
                    continue
        if font is None:
            font = ImageFont.load_default(size=size)
        text = shorten(self.ch_title)
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
        cy = self._paths[j].y_at(t) if self.follow else a.h / 2
        cur, ca, prev, pa = layout.highlight_state(self.segments, r.seg_from, r.seg_to, t)
        hl, marks = [], ()
        if self.frame_marks and cur is not None and self.segments[cur].get("words"):
            marks = self._marks(r.seg_from, cur, ca, prev, pa, t)
        else:
            if prev is not None and pa > 0:
                hl.append((prev, int(round(pa * 16))))
            if cur is not None and ca > 0:
                hl.append((cur, int(round(ca * 16))))
        return (r.page, round(self._run_cx[j], 2), round(cy, 2), round(s * zoom, 5), tuple(hl), marks)

    def _marks(self, seg_from: int, cur: int, ca: float, prev: int | None, pa: float, t: float) -> tuple:
        """Word / cursor highlight for the frame: ((kind, rect, alpha_q), ...), rects in page points
        (quantized so identical frames are still detected). kind: 0 tint, 1 highlight, 2 caret."""
        q = lambda r: tuple(round(v * 4) / 4 for v in r)  # noqa: E731 — 1/4 pt ≈ a pixel or less
        out = []
        if self.tint:
            for idx, al in ((prev, pa), (cur, ca)):
                if idx is not None and al > 0:
                    out += [(0, q(r), int(round(al * 16))) for r in self.segments[idx]["rects"]]
        seg = self.segments[cur]
        if self.hl_mode == "word":
            for rects, al in layout.word_marks(self.segments, seg_from, cur, t):
                if al > 0:
                    out += [(1, q(r), int(round(al * 16))) for r in rects]
        else:
            read, caret, al = layout.cursor_marks(seg, t)
            if al > 0:
                out += [(1, q(r), int(round(al * 16))) for r in read]
                if caret is not None:
                    out.append((2, q(caret), int(round(al * 16))))
        return tuple(out)

    def _to_frame(self, r, cx: float, cy: float, s: float) -> tuple[float, float, float, float]:
        """Page points → frame pixels for a camera at (cx, cy) with scale s."""
        mx, my = self.ox + self.CW / 2, self.oy + self.CH / 2
        return (mx + (r[0] - cx) * s, my + (r[1] - cy) * s, mx + (r[2] - cx) * s, my + (r[3] - cy) * s)

    def _draw_marks(self, img: np.ndarray, marks: tuple, cx: float, cy: float, s: float) -> None:
        for kind, r, aq in marks:
            a = aq / 16.0
            x0, y0, x1, y1 = self._to_frame(r, cx, cy, s)
            if kind == 2:
                self._draw_caret(img, x0, y0, y1, a)
                continue
            box = (int(x0), int(y0), int(np.ceil(x1)), int(np.ceil(y1)))
            self._paint(img, *box, a * (TINT if kind == 0 else 1.0))

    def _draw_caret(self, img: np.ndarray, x: float, y0: float, y1: float, a: float) -> None:
        """Reading cursor: a slim bar at the leading edge, in a deeper shade of the highlight colour."""
        h = y1 - y0
        w = max(2.0, h * 0.09)
        pady = max(1, int(h * 0.12))
        xa, xb = int(round(x - w / 2)), int(round(x + w / 2))
        ya, yb = max(0, int(y0) - pady), min(img.shape[0], int(np.ceil(y1)) + pady)
        xa, xb = max(0, xa), min(img.shape[1], max(xa + 1, xb))
        if xb <= xa or yb <= ya:
            return
        roi = img[ya:yb, xa:xb].astype(np.float32)
        col = self.hl_color * 0.55
        img[ya:yb, xa:xb] = np.clip(roi * (1 - a) + col * a, 0, 255).astype(np.uint8)

    def _render_run(self, state: tuple) -> np.ndarray:
        page, cx, cy, s, hl, marks = state
        canvas = self._canvas(page)
        img = self._composite(page, hl)
        k = s / canvas.rs
        tx = self.ox + self.CW / 2 - (canvas.margin + cx * canvas.rs) * k
        ty = self.oy + self.CH / 2 - (canvas.margin + cy * canvas.rs) * k
        M = np.array([[k, 0, tx], [0, k, ty]], dtype=np.float32)
        interp = cv2.INTER_AREA if k < 0.8 else cv2.INTER_LINEAR
        out = cv2.warpAffine(img, M, (self.W, self.H), flags=interp, borderMode=cv2.BORDER_CONSTANT, borderValue=self.bg)
        if marks:
            self._draw_marks(out, marks, cx, cy, s)
        return out

    def frame(self, t: float) -> np.ndarray:
        j = self._run_index(t)
        st = self._run_state(j, t)
        fade = None
        if j > 0 and t < self.runs[j].show_from + layout.PAGE_FADE:
            fa = (t - self.runs[j].show_from) / layout.PAGE_FADE
            fade = (self._run_state(j - 1, t), int(round(layout.smoothstep(fa) * 32)))
        prog_px = int(self.CW * min(1.0, t / self.total)) if self.show_progress else -1
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
        if self._frame is not None:
            self._frame.apply(out)
        self._last_key, self._last_frame = key, out
        return out

    # ── geometry (tests / diagnostics) ──────────────────────
    def frame_rects(self, t: float, rects) -> tuple[int, list[tuple[float, float, float, float]]]:
        """Page-space rects → frame pixel rects for the page on screen at time t: (page, rects)."""
        page, cx, cy, s, _, _ = self._run_state(self._run_index(t), t)
        return page, [self._to_frame(r, cx, cy, s) for r in rects]

    def render_plain(self, t: float) -> np.ndarray:
        """The page as framed at time t, without highlights, cross-fade or overlays."""
        page, cx, cy, s, _, _ = self._run_state(self._run_index(t), t)
        out = self._render_run((page, cx, cy, s, (), ()))
        if self._frame is not None:
            self._frame.apply(out)
        return out

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
        x, y = self.ox + int(40 * self.ui), self.oy + int(36 * self.ui)
        w, h = min(w, self.ox + self.CW - x), min(h, self.oy + self.CH - y)
        roi = out[y:y + h, x:x + w].astype(np.float32)
        src = img[:h, :w]
        al = src[..., 3:4] / 255.0 * a
        out[y:y + h, x:x + w] = (roi * (1 - al) + src[..., :3] * al).astype(np.uint8)

    def _draw_progress(self, out: np.ndarray, px: int) -> None:
        th = max(4, int(6 * self.ui))
        y1, x0, x1 = self.oy + self.CH, self.ox, self.ox + self.CW
        band = out[y1 - th:y1, x0:x1].astype(np.float32)
        band[:] = band * 0.82 + np.array(self.track, dtype=np.float32) * 0.18
        if px > 0:
            band[:, :px] = band[:, :px] * 0.1 + self.hl_color * 0.9
        out[y1 - th:y1, x0:x1] = band.astype(np.uint8)

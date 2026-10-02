"""YouTube Short: background + title + word-by-word captions + progress bar → MP4 (video only;
the narration is muxed afterwards).

Everything that does not change is drawn once: the background with the title (and the book cover
card) is one base frame, and each caption card is rendered once per spoken word as a premultiplied
patch. A frame is then a copy of the base plus one small blend, so a 60 s short renders in seconds.
Sizes scale with the frame width, so tests can render tiny videos.
"""
from __future__ import annotations

import functools
import math
import os
import re
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..errors import WorkerError
from ..util import atomic_path
from ..video.encoder import FrameWriter

cv2.setNumThreads(max(1, int(os.environ.get("RENDER_THREADS", "1") or 1)))

# top and bottom of the vertical gradient (RGB)
THEMES = {
    "midnight": ((15, 23, 42), (76, 29, 149)),
    "sunset": ((157, 23, 77), (234, 88, 12)),
    "ocean": ((8, 47, 73), (13, 148, 136)),
    "forest": ((6, 44, 34), (63, 98, 18)),
    "paper": ((250, 246, 238), (232, 220, 196)),
}
LIGHT_THEMES = {"paper"}
INK = (28, 25, 23)  # text on light themes (RGB)

# (path, face index) — heavy faces read best at Shorts size. Bangla fonts cover Latin too.
CAPTION_FONTS = [
    ("/System/Library/Fonts/Avenir Next.ttc", 8),  # Heavy
    ("/System/Library/Fonts/Supplemental/Arial Black.ttf", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
]
TITLE_FONTS = [
    ("/System/Library/Fonts/Avenir Next.ttc", 2),  # Demi Bold
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
]
BANGLA_FONTS = [
    ("/System/Library/Fonts/KohinoorBangla.ttc", 3),  # Bold
    ("/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc", 1),
    ("/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansBengali-Bold.ttf", 0),
]
_BENGALI = re.compile(r"[ঀ-৿]")
POP_SECONDS = 0.12


@functools.lru_cache(maxsize=32)
def load_font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    candidates = BANGLA_FONTS if kind.endswith("bn") else TITLE_FONTS if kind.startswith("title") else CAPTION_FONTS
    for path, index in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=index)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def font_for(text: str, kind: str, size: int) -> ImageFont.FreeTypeFont:
    return load_font(f"{kind}-bn" if _BENGALI.search(text) else kind, max(8, int(size)))


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = (h or "#FACC15").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return 250, 204, 21


def ease_out(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


# ─────────────────────────────── layers ───────────────────────────────

class Patch:
    """A premultiplied BGR patch: frame = frame * inv + col, at (x, y)."""

    __slots__ = ("x", "y", "col", "inv")

    def __init__(self, rgba: np.ndarray, x: int, y: int):
        a = rgba[..., 3:4].astype(np.float32) / 255.0
        self.col = rgba[..., [2, 1, 0]].astype(np.float32) * a
        self.inv = 1.0 - a
        self.x, self.y = int(x), int(y)

    def scaled(self, s: float, alpha: float, cx: float, cy: float) -> "Patch":
        """This patch scaled by `s` around (cx, cy) and faded to `alpha`."""
        h, w = self.col.shape[:2]
        nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
        p = Patch.__new__(Patch)
        p.col = cv2.resize(self.col, (nw, nh), interpolation=cv2.INTER_LINEAR) * alpha
        a = 1.0 - cv2.resize(self.inv, (nw, nh), interpolation=cv2.INTER_LINEAR)
        p.inv = (1.0 - a.reshape(nh, nw, 1) * alpha).astype(np.float32)
        p.x, p.y = int(round(cx - nw / 2)), int(round(cy - nh / 2))
        return p

    def blend(self, frame: np.ndarray) -> None:
        H, W = frame.shape[:2]
        h, w = self.col.shape[:2]
        x0, y0 = max(0, self.x), max(0, self.y)
        x1, y1 = min(W, self.x + w), min(H, self.y + h)
        if x1 <= x0 or y1 <= y0:
            return
        sx, sy = x0 - self.x, y0 - self.y
        roi = frame[y0:y1, x0:x1].astype(np.float32)
        out = roi * self.inv[sy:sy + y1 - y0, sx:sx + x1 - x0] + self.col[sy:sy + y1 - y0, sx:sx + x1 - x0]
        frame[y0:y1, x0:x1] = np.clip(out, 0, 255).astype(np.uint8)


def gradient(W: int, H: int, top, bottom) -> np.ndarray:
    """Vertical gradient (BGR) with a soft glow behind the captions and a vignette."""
    t = np.linspace(0.0, 1.0, H, dtype=np.float32)[:, None, None]
    top_bgr = np.array(top[::-1], dtype=np.float32)
    bottom_bgr = np.array(bottom[::-1], dtype=np.float32)
    img = np.broadcast_to(top_bgr * (1 - t) + bottom_bgr * t, (H, W, 3)).copy()
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    glow = np.exp(-(((xx - W * 0.5) / (W * 0.55)) ** 2 + ((yy - H * 0.52) / (H * 0.32)) ** 2))[..., None]
    light = sum(top) + sum(bottom) > 3 * 2 * 180
    img = img + glow * (12 if light else 26)
    vignette = 1.0 - 0.28 * np.clip(((xx - W / 2) / (W * 0.75)) ** 2 + ((yy - H / 2) / (H * 0.75)) ** 2, 0, 1)[..., None]
    return np.clip(img * vignette, 0, 255).astype(np.uint8)


def cover_background(path: str, W: int, H: int, zoom: float) -> np.ndarray:
    """The cover, filling a frame `zoom` times larger, heavily blurred and darkened (BGR)."""
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise WorkerError("SHORT_COVER_UNREADABLE", "The book cover image could not be read.", {"path": path})
    BW, BH = int(W * zoom), int(H * zoom)
    ih, iw = img.shape[:2]
    s = max(BW / iw, BH / ih)
    img = cv2.resize(img, (int(iw * s) + 1, int(ih * s) + 1), interpolation=cv2.INTER_AREA)
    y0, x0 = (img.shape[0] - BH) // 2, (img.shape[1] - BW) // 2
    img = img[y0:y0 + BH, x0:x0 + BW]
    small = cv2.resize(img, (max(1, BW // 16), max(1, BH // 16)), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), 4)
    img = cv2.resize(small, (BW, BH), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    t = np.linspace(0.0, 1.0, BH, dtype=np.float32)[:, None, None]
    img = img * (0.5 - 0.18 * t)  # darker towards the bottom, where the captions sit
    return np.clip(img, 0, 255).astype(np.uint8)


def cover_card(path: str, max_w: int, max_h: int, radius: int) -> np.ndarray:
    """The sharp cover with rounded corners and a soft shadow (RGBA)."""
    im = Image.open(path).convert("RGB")
    s = min(max_w / im.width, max_h / im.height)
    im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    pad = max(4, radius * 2)
    canvas = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + radius // 2, pad + im.width, pad + im.height + radius // 2), radius, fill=150)
    canvas.putalpha(shadow.filter(ImageFilter.GaussianBlur(pad / 2.5)))
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius, fill=255)
    canvas.paste(im, (pad, pad), mask)
    return np.array(canvas)


def wrap(words: list[str], font: ImageFont.FreeTypeFont, max_w: float) -> list[list[int]]:
    """Greedy line breaking; returns word indices per line. Two lines are balanced ("WHAT IF / ONE
    QUIET", not "WHAT IF ONE / QUIET")."""
    space = font.getlength(" ")
    lens = [font.getlength(w) for w in words]
    lines: list[list[int]] = [[]]
    width = 0.0
    for i, ww in enumerate(lens):
        if lines[-1] and width + space + ww > max_w:
            lines.append([])
            width = 0.0
        width += (space if lines[-1] else 0) + ww
        lines[-1].append(i)
    if len(lines) == 2:
        line_w = lambda a, b: sum(lens[a:b]) + space * (b - a - 1)  # noqa: E731
        n = len(words)
        best = min(range(1, n), key=lambda k: max(line_w(0, k), line_w(k, n)))
        if max(line_w(0, best), line_w(best, n)) <= max_w:
            lines = [list(range(0, best)), list(range(best, n))]
    return lines


def text_block(text: str, kind: str, size: float, max_w: float, max_lines: int, fill, shadow: bool) -> np.ndarray:
    """Centered, wrapped text (the title) as RGBA."""
    words = text.split()
    font = font_for(text, kind, size)
    lines = wrap(words, font, max_w)
    while len(lines) > max_lines and size > 10:
        size *= 0.9
        font = font_for(text, kind, size)
        lines = wrap(words, font, max_w)
    lines = lines[:max_lines]
    asc, desc = font.getmetrics()
    lh = int((asc + desc) * 1.08)
    pad = int(size * 0.3)
    widths = [font.getlength(" ".join(words[i] for i in ln)) for ln in lines]
    W, H = int(max(widths, default=1) + 2 * pad), int(lh * len(lines) + 2 * pad)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for li, ln in enumerate(lines):
        x = (W - widths[li]) / 2
        d.text((x, pad + li * lh + asc), " ".join(words[i] for i in ln), font=font, anchor="ls", fill=(*fill, 255))
    if shadow:
        sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
        sh.putalpha(img.getchannel("A").filter(ImageFilter.GaussianBlur(max(1, size * 0.08))).point(lambda v: v * 0.6))
        img = Image.alpha_composite(sh, img)
    return np.array(img)


# ─────────────────────────────── captions ───────────────────────────────

class Captions:
    """Lays out each caption card once and renders one patch per highlighted word (cached)."""

    def __init__(self, groups: list[dict], W: int, H: int, look: dict, center_y: float, language: str):
        self.groups = groups
        self.W, self.H, self.u = W, H, W / 1080.0
        self.style = look.get("captions", "karaoke")
        self.light = look.get("theme") in LIGHT_THEMES
        if self.light and self.style == "karaoke":
            self.style = "box"  # an accent-coloured word is unreadable on paper; a pill is not
        self.accent = hex_rgb(look.get("accent", "#FACC15"))
        self.upper = bool(look.get("uppercase")) and language != "bn"
        self.center_y = center_y
        self.max_w = W * (0.82 if self.style == "word" else 0.8)
        self.size = (132 if self.style == "word" else 92) * self.u
        self.cache: dict[tuple[int, int], Patch] = {}
        self.cached_group = -1

    def words(self, gi: int) -> list[str]:
        ws = [w["t"] for w in self.groups[gi]["words"]]
        return [w.upper() for w in ws] if self.upper else ws

    def active_word(self, gi: int, t: float) -> int:
        ws = self.groups[gi]["words"]
        if self.style == "plain" or t >= ws[-1]["end"]:
            return -1
        for i in range(len(ws) - 1, -1, -1):
            if t >= ws[i]["start"]:
                return i
        return -1

    def patch(self, gi: int, active: int) -> Patch:
        if gi != self.cached_group:
            self.cache.clear()
            self.cached_group = gi
        key = (gi, active)
        if key not in self.cache:
            self.cache[key] = self._render(gi, active)
        return self.cache[key]

    def _render(self, gi: int, active: int) -> Patch:
        words = self.words(gi)
        text = " ".join(words)
        size = self.size
        font = font_for(text, "caption", size)
        lines = wrap(words, font, self.max_w)
        # A card is at most two lines; a long word shrinks the text instead of overflowing.
        while size > 24 * self.u and (len(lines) > 2 or max(font.getlength(w) for w in words) > self.max_w):
            size *= 0.92
            font = font_for(text, "caption", size)
            lines = wrap(words, font, self.max_w)
        bn = bool(_BENGALI.search(text))
        asc, desc = font.getmetrics()
        lh = int((asc + desc) * (1.12 if bn else 1.02))
        stroke = 0 if self.light else max(2, int(size * 0.075))
        boxpad = int(size * 0.16)
        pad = int(stroke + size * 0.25 + boxpad)
        space = font.getlength(" ")
        widths = [sum(font.getlength(words[i]) for i in ln) + space * (len(ln) - 1) for ln in lines]
        cw, ch = int(max(widths) + 2 * pad), int(lh * len(lines) + 2 * pad)
        img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        white, ink = (255, 255, 255), INK
        base_fill = ink if self.light else white
        for li, ln in enumerate(lines):
            x = (cw - widths[li]) / 2
            baseline = pad + li * lh + asc
            for i in ln:
                w = words[i]
                ww = font.getlength(w)
                fill = base_fill
                if i == active and self.style in ("karaoke", "word"):
                    fill = self.accent
                if i == active and self.style == "box":
                    top = baseline - asc * (0.86 if not bn else 0.95) - boxpad * 0.6
                    bottom = baseline + desc * (0.45 if not bn else 0.7) + boxpad * 0.6
                    d.rounded_rectangle((x - boxpad, top, x + ww + boxpad, bottom), radius=int(size * 0.2), fill=(*self.accent, 255))
                    fill = ink
                    d.text((x, baseline), w, font=font, anchor="ls", fill=(*fill, 255))
                else:
                    d.text((x, baseline), w, font=font, anchor="ls", fill=(*fill, 255),
                           stroke_width=stroke, stroke_fill=(0, 0, 0, 255) if stroke else None)
                x += ww + space
        # soft drop shadow so captions stay readable on any background
        sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
        alpha = img.getchannel("A").filter(ImageFilter.GaussianBlur(max(1, size * 0.09)))
        sh.putalpha(alpha.point(lambda v: v * (0.25 if self.light else 0.55)))
        offset = int(size * 0.05)
        shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
        shadow.paste(sh, (0, offset))
        img = Image.alpha_composite(shadow, img)
        arr = np.array(img)
        return Patch(arr, (self.W - cw) / 2, self.center_y - ch / 2)


# ─────────────────────────────── short ───────────────────────────────

class ShortCompositor:
    def __init__(self, params: dict):
        self.W, self.H = int(params["width"]), int(params["height"])
        self.u = self.W / 1080.0
        self.duration = float(params["duration"])
        look = params.get("look", {})
        self.look = look
        theme = look.get("theme", "midnight")
        cover = params.get("coverPath") if theme == "cover" else None
        if theme == "cover" and not (cover and os.path.exists(cover)):
            theme, cover = "midnight", None
        self.light = theme in LIGHT_THEMES
        self.accent = hex_rgb(look.get("accent", "#FACC15"))
        self.show_progress = bool(look.get("showProgress", True))
        self.zoom_bg = None
        self.zoom = 1.07
        if cover:
            self.zoom_bg = cover_background(cover, self.W, self.H, self.zoom)
            base = self._zoomed(0.0)
        else:
            top, bottom = THEMES.get(theme, THEMES["midnight"])
            base = gradient(self.W, self.H, top, bottom)

        # static layer: title + cover card
        statics: list[Patch] = []
        y = self.H * 0.085
        title = (params.get("title") or "").strip()
        if title:
            arr = text_block(title, "title", 64 * self.u, self.W * 0.84, 3, INK if self.light else (255, 255, 255), not self.light)
            statics.append(Patch(arr, (self.W - arr.shape[1]) / 2, y))
            y += arr.shape[0] + 24 * self.u
        if cover:
            card = cover_card(cover, int(self.W * 0.5), int(self.H * 0.3), int(18 * self.u))
            statics.append(Patch(card, (self.W - card.shape[1]) / 2, y))
            y += card.shape[0]
        lower = look.get("position") == "lower"
        center_y = self.H * (0.66 if lower else 0.52)
        if cover:  # below the card, above YouTube's caption area
            center_y = max(center_y, min(self.H * 0.7, y + self.H * 0.1))
        self.statics = statics
        self.base = base
        if not cover:
            for p in statics:
                p.blend(self.base)
            self.statics = []
        self.captions = Captions(params.get("groups") or [], self.W, self.H, look, center_y, params.get("language", "en"))
        self._gi = 0

    def _zoomed(self, t: float) -> np.ndarray:
        """Slow push-in on the blurred cover (1.0 → 1.07 over the short)."""
        BH, BW = self.zoom_bg.shape[:2]
        k = 1.0 + (self.zoom - 1.0) * (t / max(self.duration, 1e-6))
        s = k / self.zoom
        M = np.float32([[s, 0, (self.W - BW * s) / 2], [0, s, (self.H - BH * s) / 2]])
        return cv2.warpAffine(self.zoom_bg, M, (self.W, self.H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    def _group_at(self, t: float) -> int:
        groups = self.captions.groups
        if not groups:
            return -1
        while self._gi + 1 < len(groups) and t >= groups[self._gi + 1]["start"]:
            self._gi += 1
        while self._gi > 0 and t < groups[self._gi]["start"]:
            self._gi -= 1
        g = groups[self._gi]
        return self._gi if g["start"] <= t < g["end"] or (self._gi == len(groups) - 1 and t >= g["start"]) else -1

    def frame(self, t: float) -> np.ndarray:
        if self.zoom_bg is not None:
            img = self._zoomed(t)
            for p in self.statics:
                p.blend(img)
        else:
            img = self.base.copy()
        gi = self._group_at(t)
        if gi >= 0:
            patch = self.captions.patch(gi, self.captions.active_word(gi, t))
            age = t - self.captions.groups[gi]["start"]
            if age < POP_SECONDS:
                e = ease_out(age / POP_SECONDS)
                h, w = patch.col.shape[:2]
                patch = patch.scaled(0.86 + 0.14 * e, 0.35 + 0.65 * e, patch.x + w / 2, patch.y + h / 2)
            patch.blend(img)
        if self.show_progress:
            bh = max(2, int(8 * self.u))
            x = int(self.W * min(1.0, t / max(self.duration, 1e-6)))
            track = img[:bh]
            img[:bh] = (track * 0.7 + (40 if self.light else 255) * 0.3).astype(np.uint8)
            if x > 0:
                img[:bh, :x] = self.accent[::-1]
        return img


def render_short(params: dict, ctx=None) -> dict:
    fps = int(params["fps"])
    duration = float(params["duration"])
    if duration <= 0:
        raise WorkerError("SHORT_EMPTY", "The short has no narration to show.")
    comp = ShortCompositor(params)
    enc = params.get("encoder", {})
    total = int(math.ceil(duration * fps - 1e-6))
    started = time.monotonic()
    with atomic_path(params["outPath"]) as tmp:
        writer = FrameWriter(tmp, comp.W, comp.H, fps, enc.get("codec", "auto"), enc.get("bitrate", "6M"),
                             int(enc.get("crf", 20)), enc.get("ffmpeg", "ffmpeg"))
        try:
            for i in range(total):
                writer.write(np.ascontiguousarray(comp.frame(i / fps)).data)
                if ctx and (i % 15 == 0 or i == total - 1):
                    ctx.progress(i + 1, total, None, phase="frames")
            writer.close()
        except BaseException:
            writer.abort()
            raise
    elapsed = time.monotonic() - started
    return {"path": params["outPath"], "frames": total, "codec": writer.codec, "renderSeconds": round(elapsed, 2),
            "size": os.path.getsize(params["outPath"])}


def render_short_rpc(params: dict, ctx) -> dict:
    return render_short(params, ctx)

"""Animated backgrounds ("scenes") and motion overlays for YouTube Shorts.

Everything is drawn from code (no image or video assets) and is a pure function of time: frame(t)
never depends on the frame before, so any frame can be drawn on its own and a re-render is
identical (the randomness is seeded).

Soft fields (aurora, liquid, nebula, rays) are computed at a quarter of the frame size and scaled
up: they have no sharp edges, so nothing is lost and it is 16× cheaper. Sharp things (stars, grid
lines, wave crests, particles) are drawn at full size with OpenCV. Sizes scale with the frame
width, so tests can render tiny videos. The web preview mirrors these in SVG
(apps/web/lib/short-scenes.ts).
"""
from __future__ import annotations

import math

import cv2
import numpy as np

TAU = 2 * math.pi


def _bgr(rgb) -> np.ndarray:
    return np.array(rgb[::-1], dtype=np.float32)


def _vgradient(h: int, w: int, stops: list[tuple[float, tuple[int, int, int]]]) -> np.ndarray:
    """Vertical multi-stop gradient (BGR float32, 0..255)."""
    y = np.linspace(0.0, 1.0, h, dtype=np.float32)
    pos = [p for p, _ in stops]
    chans = [np.interp(y, pos, [c[i] for _, c in stops]) for i in (2, 1, 0)]
    col = np.stack(chans, axis=-1).astype(np.float32)
    return np.broadcast_to(col[:, None, :], (h, w, 3)).copy()


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _hash(*v: float) -> float:
    """Deterministic pseudo-random 0..1 from numbers (a new spot for each life of a particle)."""
    s = math.sin(sum(x * k for x, k in zip(v, (12.9898, 78.233, 37.719)))) * 43758.5453
    return s - math.floor(s)


class Scene:
    """An animated background: frame(t) → a new BGR uint8 image (H, W, 3)."""

    def __init__(self, W: int, H: int, focus: float):
        self.W, self.H, self.u = W, H, W / 1080.0
        # the soft-field grid: a quarter of the frame, coordinates in frame-width units
        self.w, self.h = max(8, W // 4), max(8, H // 4)
        self.x = ((np.arange(self.w, dtype=np.float32) + 0.5) / self.w)
        self.y = ((np.arange(self.h, dtype=np.float32) + 0.5) / self.h)
        self.aspect = H / W
        # dimmer behind the captions so they stay the brightest thing on screen
        self.calm = (1.0 - 0.22 * np.exp(-(((self.y - focus) / 0.11) ** 2)))[:, None, None].astype(np.float32)
        self.rng = np.random.default_rng(7)

    def upscale(self, small: np.ndarray) -> np.ndarray:
        small = np.clip(small, 0, 255).astype(np.uint8)
        return cv2.resize(small, (self.W, self.H), interpolation=cv2.INTER_CUBIC)

    def frame(self, t: float) -> np.ndarray:  # pragma: no cover - abstract
        raise NotImplementedError


class Stars:
    """Twinkling stars drawn sharp at full size, in the top `extent` of the frame."""

    def __init__(self, rng, W: int, H: int, n: int, extent: float = 1.0, big: int = 0):
        u = W / 1080.0
        self.u = u
        self.xy = np.stack([rng.uniform(0, W, n), rng.uniform(0, H * extent, n)], axis=1)
        self.r = rng.choice([1, 1, 1, 2, 2, 3], n) * max(0.5, u)
        self.base = rng.uniform(0.35, 0.9, n)
        self.freq = rng.uniform(0.15, 0.6, n)
        self.phase = rng.uniform(0, TAU, n)
        self.tint = rng.uniform(0, 1, n)
        self.big = min(big, n)

    def draw(self, img: np.ndarray, t: float, gain: float = 1.0) -> None:
        b = np.clip(self.base * (0.65 + 0.35 * np.sin(TAU * self.freq * t + self.phase)) * gain, 0, 1)
        for i in range(len(b)):
            x, y = int(self.xy[i, 0]), int(self.xy[i, 1])
            v = b[i] * 255
            col = (v, v * (0.9 + 0.1 * self.tint[i]), v * (0.8 + 0.2 * (1 - self.tint[i])))
            r = max(1, int(round(self.r[i])))
            cv2.circle(img, (x, y), r, col, -1, cv2.LINE_AA)
            if i < self.big:  # a soft cross flare on the brightest few
                arm = int(r * 7 * (0.6 + 0.4 * b[i]))
                c2 = tuple(c * 0.45 for c in col)
                cv2.line(img, (x - arm, y), (x + arm, y), c2, 1, cv2.LINE_AA)
                cv2.line(img, (x, y - arm), (x, y + arm), c2, 1, cv2.LINE_AA)


# ─────────────────────────────── scenes ───────────────────────────────

class Aurora(Scene):
    """Northern lights: glowing curtains that ripple across a starry night sky."""

    BANDS = [  # colour, height, amplitude, speed
        ((52, 211, 153), 0.30, 0.045, 0.030),
        ((34, 211, 238), 0.43, 0.055, -0.022),
        ((167, 139, 250), 0.56, 0.040, 0.026),
    ]

    def __init__(self, W, H, focus):
        super().__init__(W, H, focus)
        self.sky = _vgradient(self.h, self.w, [(0, (2, 6, 23)), (0.6, (6, 22, 40)), (1, (4, 30, 34))])
        self.stars = Stars(self.rng, W, H, int(110 * (W * H) / (1080 * 1920)) + 12, 0.75, 4)
        self.phases = self.rng.uniform(0, TAU, (len(self.BANDS), 3))

    def frame(self, t):
        x, y = self.x, self.y[:, None]
        acc = np.zeros((self.h, self.w, 3), np.float32)
        for (col, h0, amp, spd), ph in zip(self.BANDS, self.phases):
            yc = (h0 + amp * np.sin(TAU * (1.3 * x + spd * t) + ph[0])
                  + amp * 0.5 * np.sin(TAU * (2.9 * x - spd * 1.7 * t) + ph[1]))[None, :]
            d = y - yc
            curtain = np.where(d < 0, np.exp(-((d / 0.13) ** 2)), np.exp(-((d / 0.022) ** 2)))
            rays = 0.6 + 0.4 * (0.5 + 0.5 * np.sin(TAU * (17 * x + 0.07 * t) + 3 * np.sin(TAU * (2.1 * x - 0.04 * t) + ph[2])))[None, :]
            pulse = 0.85 + 0.15 * math.sin(TAU * 0.07 * t + ph[2])
            acc += (curtain * rays * pulse)[..., None] * _bgr(col)
        img = self.upscale((self.sky + acc * 0.85) * self.calm)
        self.stars.draw(img, t, 0.8)
        return img


class Liquid(Scene):
    """A slow lava-lamp mesh: big colour blobs drifting and mixing."""

    BLOBS = [(236, 72, 153), (139, 92, 246), (249, 115, 22), (59, 130, 246), (20, 184, 166)]

    def __init__(self, W, H, focus):
        super().__init__(W, H, focus)
        self.base = np.float32([0.08, 0.04, 0.10])  # BGR 0..1
        n = len(self.BLOBS)
        self.params = np.stack([
            self.rng.uniform(0.25, 0.45, n),   # x amplitude
            self.rng.uniform(0.3, 0.55, n),    # y amplitude (frame heights)
            self.rng.uniform(13, 23, n),       # x period (s)
            self.rng.uniform(17, 29, n),       # y period (s)
            self.rng.uniform(0, TAU, n), self.rng.uniform(0, TAU, n),
            self.rng.uniform(0.34, 0.48, n),   # radius (frame widths)
        ], axis=1)

    def frame(self, t):
        X, Y = self.x, self.y * self.aspect
        acc = np.zeros((self.h, self.w, 3), np.float32)
        weight = np.zeros((self.h, self.w), np.float32)
        cover = np.zeros((self.h, self.w), np.float32)
        for col, (ax, ay, px, py, fx, fy, r) in zip(self.BLOBS, self.params):
            cx = 0.5 + ax * math.sin(TAU * t / px + fx)
            cy = self.aspect * (0.5 + ay * 0.5 * math.sin(TAU * t / py + fy))
            g = np.exp(-((Y - cy) / r) ** 2)[:, None] * np.exp(-((X - cx) / r) ** 2)[None, :]
            k = g ** 3  # the nearest blob dominates, so the colours stay distinct instead of mixing to mud
            acc += k[..., None] * _bgr(col)
            weight += k
            cover += g
        # a weighted mix of the blob colours (stays saturated where they overlap, unlike adding light)
        mix = acc / (weight[..., None] + 1e-4)
        cover = (1.0 - np.exp(-cover * 2.4))[..., None]
        img = self.base * 255.0 * (1 - cover) + mix * cover
        return self.upscale(img * 0.9 * self.calm)


class Galaxy(Scene):
    """Deep space: a nebula slowly turning behind twinkling stars."""

    def __init__(self, W, H, focus):
        super().__init__(W, H, focus)
        S = int(math.hypot(self.w, self.h)) + 4
        self.S = S

        def noise(seed_scale):
            out = np.zeros((S, S), np.float32)
            for octave, wgt in ((4, 0.5), (8, 0.28), (16, 0.14), (32, 0.08)):
                n = self.rng.random((octave * seed_scale, octave * seed_scale)).astype(np.float32)
                out += cv2.resize(n, (S, S), interpolation=cv2.INTER_CUBIC) * wgt
            return out

        yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) / S - 0.5
        arm = np.exp(-(((xx * 0.55 + yy * 0.84) / 0.2) ** 2))  # a diagonal band, like a galaxy arm
        core = np.exp(-((xx ** 2 + yy ** 2) / 0.05))
        tex = np.zeros((S, S, 3), np.float32)
        for col, k in (((139, 92, 246), 1.0), ((236, 72, 153), 0.7), ((56, 189, 248), 0.55)):
            n = np.clip((noise(1) - 0.42) * 2.6, 0, 1) ** 1.5
            tex += (n * (0.35 + 0.65 * arm) * k)[..., None] * _bgr(col)
        tex += (core * 0.5)[..., None] * _bgr((250, 232, 255))
        self.tex = tex
        self.space = _vgradient(self.h, self.w, [(0, (3, 4, 16)), (1, (12, 8, 32))])
        self.stars = Stars(self.rng, W, H, int(190 * (W * H) / (1080 * 1920)) + 16, 1.0, 7)

    def frame(self, t):
        angle = 1.1 * t  # degrees
        zoom = 1.0 + 0.04 * math.sin(TAU * t / 30)
        M = cv2.getRotationMatrix2D((self.S / 2, self.S / 2), angle, zoom)
        M[:, 2] += (self.w - self.S) / 2, (self.h - self.S) / 2
        neb = cv2.warpAffine(self.tex, M, (self.w, self.h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        img = self.upscale((self.space + neb * 0.8) * self.calm)
        self.stars.draw(img, t)
        return img


class Synthwave(Scene):
    """Retro-future: a striped sun over a neon grid that rushes towards you."""

    def __init__(self, W, H, focus):
        super().__init__(W, H, focus)
        u = self.u
        self.hy = hy = int(H * 0.72)
        base = np.zeros((H, W, 3), np.float32)
        base[:hy] = _vgradient(hy, W, [(0, (16, 5, 38)), (0.65, (60, 12, 82)), (1, (150, 30, 110))])
        base[hy:] = _vgradient(H - hy, W, [(0, (36, 6, 54)), (1, (8, 2, 20))])
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        # glow on the horizon and around the sun
        self.R = R = int(W * 0.26)
        self.sc = (W // 2, int(hy - R * 0.42))
        glow = np.exp(-(((yy - hy) / (H * 0.035)) ** 2))[..., None] * _bgr((255, 70, 160)) * 0.55
        halo = np.exp(-(((xx - self.sc[0]) ** 2 + (yy - self.sc[1]) ** 2) / (R * 1.5) ** 2))[..., None] * _bgr((255, 90, 120)) * 0.35
        above = (yy < hy)[..., None]
        base = base + glow + halo * above
        img = np.clip(base, 0, 255).astype(np.uint8)
        Stars(self.rng, W, H, int(70 * (W * H) / (1080 * 1920)) + 8, 0.5, 3).draw(img, 0.0, 0.8)
        self.base = img
        # the sun: a top-to-bottom yellow→pink disc, cut off at the horizon (premultiplied BGR + alpha)
        d = 2 * R + 2
        sy, sx = np.mgrid[0:d, 0:d].astype(np.float32)
        dist = np.hypot(sx - R, sy - R)
        a = np.clip(R - dist + 0.5, 0, 1)
        rows = self.sc[1] - R + np.arange(d)
        a[rows >= hy] = 0
        g = (sy / (2 * R))[..., None]
        col = _bgr((255, 221, 87)) * (1 - g) + _bgr((255, 50, 130)) * g
        self.sun_col, self.sun_a = col * a[..., None], a
        self.sun_ry = np.arange(d, dtype=np.float32) / (2 * R)  # 0 at the top of the disc, 1 at the bottom
        self.lines = 15
        self.grid_col = (210, 60, 255)  # BGR magenta
        self.glow_scale = 4

    def _sun(self, img, t):
        ry = self.sun_ry
        lower = np.clip((ry - 0.45) / 0.55, 0, 1)
        gap = 0.06 + 0.42 * lower
        stripe = ((ry * 9.0 - t * 0.35) % 1.0) < gap
        m = np.where((ry > 0.45) & stripe, 0.0, 1.0).astype(np.float32)
        a = self.sun_a * m[:, None]
        col = self.sun_col * m[:, None, None]
        R = self.R
        x0, y0 = self.sc[0] - R, self.sc[1] - R
        H, W = img.shape[:2]
        xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + col.shape[1]), min(H, y0 + col.shape[0])
        if xb <= xa or yb <= ya:
            return
        sx, sy = xa - x0, ya - y0
        roi = img[ya:yb, xa:xb].astype(np.float32)
        aa = a[sy:sy + yb - ya, sx:sx + xb - xa, None]
        img[ya:yb, xa:xb] = np.clip(roi * (1 - aa) + col[sy:sy + yb - ya, sx:sx + xb - xa], 0, 255).astype(np.uint8)

    def _grid_lines(self, t, W, H, hy, s=1.0):
        """Line segments of the floor (in a frame scaled by `s`) and their brightness."""
        segs = []
        cx = W / 2
        span = W * 0.17
        for k in range(-12, 13):
            segs.append(((cx + k * span * 0.07, hy), (cx + k * span * 1.6, H), 0.9))
        f = (t * 0.9) % 1.0
        for j in range(self.lines):
            z = j + 1 - f
            y = hy + (H - hy) * 0.55 / z
            if y > H + 4 * s:
                continue
            a = float(np.clip((y - hy) / (H - hy) * 2.6, 0, 1))
            segs.append(((0, y), (W, y), a))
        return segs

    def frame(self, t):
        img = self.base.copy()
        self._sun(img, t)
        W, H, hy = self.W, self.H, self.hy
        # the floor: crisp lines plus a blurred low-res copy of them as a neon glow
        floor = np.zeros((H - hy, W, 3), np.uint8)
        th = max(1, int(round(2 * self.u)))
        for (x0, y0), (x1, y1), a in self._grid_lines(t, W, H, hy):
            c = tuple(v * a for v in self.grid_col)
            cv2.line(floor, (int(x0), int(y0 - hy)), (int(x1), int(y1 - hy)), c, th, cv2.LINE_AA)
        k = self.glow_scale
        gh, gw = max(2, (H - hy) // k), max(2, W // k)
        glow = cv2.resize(floor, (gw, gh), interpolation=cv2.INTER_AREA)
        glow = cv2.GaussianBlur(glow, (0, 0), 1.6)
        glow = cv2.resize(glow, (W, H - hy), interpolation=cv2.INTER_LINEAR)
        region = img[hy:]
        region[:] = cv2.add(cv2.add(region, floor), cv2.convertScaleAbs(glow, alpha=2.2))
        return img


class Waves(Scene):
    """Dusk over the sea: layered waves rolling past at different speeds."""

    LAYERS = [  # base height, amplitude (px at 1080 wide), wavelength (frame widths), speed, colour
        (0.605, 5, 0.42, 0.10, (113, 80, 140)),
        (0.655, 9, 0.55, 0.16, (70, 62, 128)),
        (0.725, 16, 0.70, 0.24, (38, 44, 102)),
        (0.81, 26, 0.85, 0.34, (20, 28, 72)),
        (0.91, 38, 1.05, 0.46, (9, 14, 42)),
    ]

    def __init__(self, W, H, focus):
        super().__init__(W, H, focus)
        hz = 0.6
        base = _vgradient(H, W, [(0, (14, 16, 56)), (0.3, (72, 34, 110)), (0.5, (196, 84, 110)), (hz, (252, 160, 92)), (1, (252, 160, 92))])
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        sun_c, sun_r = (W * 0.5, H * hz), W * 0.13
        d = np.hypot(xx - sun_c[0], yy - sun_c[1])
        base += (np.exp(-((d / (sun_r * 3.2)) ** 2)) * 0.6)[..., None] * _bgr((255, 200, 120))
        disc = np.clip(sun_r - d + 0.5, 0, 1)[..., None]
        base = base * (1 - disc) + disc * _bgr((255, 236, 170))
        self.base = np.clip(base, 0, 255).astype(np.uint8)
        self.phases = self.rng.uniform(0, TAU, (len(self.LAYERS), 2))
        self.xs = np.linspace(-8, W + 8, max(24, W // 8)).astype(np.float32)

    def frame(self, t):
        img = self.base.copy()
        W, H, u = self.W, self.H, self.u
        for i, ((h0, amp, wl, spd, col), ph) in enumerate(zip(self.LAYERS, self.phases)):
            x = self.xs / W
            y = H * h0 + amp * u * (0.7 * np.sin(TAU * (x / wl - spd * t) + ph[0]) + 0.3 * np.sin(TAU * (x / (wl * 0.45) + spd * 0.6 * t) + ph[1]))
            pts = np.stack([self.xs, y], axis=1)
            poly = np.vstack([pts, [[W + 8, H + 8], [-8, H + 8]]]).astype(np.int32)
            cv2.fillPoly(img, [poly], col[::-1], cv2.LINE_AA)
            crest = tuple(min(255, c * 1.6 + 30) for c in col[::-1])
            cv2.polylines(img, [pts.astype(np.int32)], False, crest, max(1, int(round(2 * u))), cv2.LINE_AA)
        return img


class Rays(Scene):
    """A sunburst: soft beams of light turning slowly behind the captions."""

    def __init__(self, W, H, focus):
        super().__init__(W, H, focus)
        X, Y = np.meshgrid(self.x, self.y * self.aspect)
        cy = 0.45 * self.aspect
        self.theta = np.arctan2(Y - cy, X - 0.5).astype(np.float32)
        self.r = np.hypot(X - 0.5, Y - cy).astype(np.float32)
        self.dark, self.light, self.glow = _bgr((22, 20, 64)), _bgr((70, 58, 196)), _bgr((190, 196, 255))

    def frame(self, t):
        s = np.cos(14 * (self.theta - 0.09 * t))
        beams = _smoothstep(-0.3, 0.3, s) * np.exp(-self.r * 0.9)
        glow = np.exp(-((self.r / 0.3) ** 2)) * (0.55 + 0.1 * math.sin(TAU * t / 6))
        img = self.dark + beams[..., None] * (self.light - self.dark) + glow[..., None] * self.glow * 0.6
        vignette = 1.0 - 0.45 * np.clip(self.r / 1.0, 0, 1) ** 2
        return self.upscale(img * vignette[..., None] * self.calm)


SCENES = {"aurora": Aurora, "liquid": Liquid, "galaxy": Galaxy, "synthwave": Synthwave, "waves": Waves, "rays": Rays}


# ─────────────────────────────── motion overlays ───────────────────────────────

def _sprite_disc(r: float, color, rim: bool = False) -> np.ndarray:
    """A soft disc of light (BGR uint8) of radius r: a bokeh orb with a brighter rim, or a glow."""
    R = max(1, int(math.ceil(r * 1.25)))
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1].astype(np.float32)
    d = np.hypot(xx, yy) / max(r, 0.5)
    if rim:
        a = _smoothstep(1.0, 0.86, d) * (0.65 + 0.35 * np.clip(d, 0, 1) ** 4)
    else:
        a = np.exp(-(d ** 2) * 2.2)
    return np.clip(a[..., None] * _bgr(color), 0, 255).astype(np.uint8)


def _sprite_spark(size: float, color) -> np.ndarray:
    """A four-pointed sparkle (BGR uint8)."""
    R = max(2, int(math.ceil(size)))
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1].astype(np.float32) / max(size, 1)
    w = 0.06
    arms = np.exp(-((yy / w) ** 2)) * np.clip(1 - np.abs(xx), 0, 1) ** 2 + np.exp(-((xx / w) ** 2)) * np.clip(1 - np.abs(yy), 0, 1) ** 2
    core = np.exp(-(xx ** 2 + yy ** 2) / 0.02)
    a = np.clip(arms + core, 0, 1)
    return np.clip(a[..., None] * _bgr(color), 0, 255).astype(np.uint8)


def _stamp(layer: np.ndarray, sprite: np.ndarray, cx: float, cy: float, gain: float) -> None:
    """Add `sprite` × gain onto `layer`, centred at (cx, cy), clipped to the frame."""
    if gain <= 0.004:
        return
    h, w = sprite.shape[:2]
    x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
    H, W = layer.shape[:2]
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if xb <= xa or yb <= ya:
        return
    roi = layer[ya:yb, xa:xb]
    spr = sprite[ya - y0:yb - y0, xa - x0:xb - x0]
    roi[:] = cv2.addWeighted(roi, 1.0, spr, float(gain), 0)


class Motion:
    """Particles drawn as light on a black layer, then added to the frame (subtracted on light
    backgrounds, so they show as soft ink instead of disappearing)."""

    INK_DELTA = (125, 150, 172)  # paper minus a warm ink: what a "dark" particle takes away

    def __init__(self, W: int, H: int, accent, light: bool):
        self.W, self.H, self.u = W, H, W / 1080.0
        self.accent = tuple(accent)
        self.light = light
        self.rng = np.random.default_rng(11)
        self.area = (W * H) / (1080 * 1920)

    def col(self, rgb):
        return self.INK_DELTA if self.light else rgb

    def apply(self, img: np.ndarray, t: float) -> None:
        layer = np.zeros_like(img)
        self.draw(layer, t)
        if self.light:
            cv2.subtract(img, cv2.convertScaleAbs(layer, alpha=0.7), dst=img)
        else:
            cv2.add(img, layer, dst=img)

    def draw(self, layer: np.ndarray, t: float) -> None:  # pragma: no cover - abstract
        raise NotImplementedError


class Bokeh(Motion):
    """Out-of-focus orbs of light floating upwards, in the accent colour and warm white."""

    def __init__(self, W, H, accent, light):
        super().__init__(W, H, accent, light)
        n = 18
        r = self.rng
        self.p = [dict(x=r.uniform(0, W), y=r.uniform(0, H), rad=r.uniform(28, 105) * self.u, vy=r.uniform(14, 42) * self.u,
                       sway=r.uniform(15, 55) * self.u, per=r.uniform(7, 15), ph=r.uniform(0, TAU), gain=r.uniform(0.16, 0.42),
                       pulse=r.uniform(4, 9)) for _ in range(n)]
        for i, q in enumerate(self.p):
            q["spr"] = _sprite_disc(q["rad"], self.col(self.accent if i % 5 < 3 else (255, 236, 210)), rim=True)

    def draw(self, layer, t):
        H = self.H
        for q in self.p:
            span = H + 2 * q["rad"]
            y = (q["y"] - q["vy"] * t) % span - q["rad"]
            x = q["x"] + q["sway"] * math.sin(TAU * t / q["per"] + q["ph"])
            g = q["gain"] * (0.75 + 0.25 * math.sin(TAU * t / q["pulse"] + q["ph"]))
            _stamp(layer, q["spr"], x, y, g)


class Snow(Motion):
    """Snowflakes drifting down; the bigger (nearer) ones fall faster."""

    def __init__(self, W, H, accent, light):
        super().__init__(W, H, accent, light)
        n = int(120 * self.area) + 10
        r = self.rng
        self.p = []
        sprites: dict[int, np.ndarray] = {}
        for _ in range(n):
            rad = float(r.choice([2, 2, 3, 3, 4, 5, 6, 8])) * self.u
            key = max(1, int(round(rad * 2)))
            if key not in sprites:
                sprites[key] = _sprite_disc(key / 2, self.col((240, 246, 255)))
            self.p.append(dict(x=r.uniform(0, W), y=r.uniform(0, H), vy=(40 + 22 * rad / self.u) * self.u, sway=r.uniform(8, 40) * self.u,
                               per=r.uniform(3, 8), ph=r.uniform(0, TAU), gain=r.uniform(0.55, 1.0), spr=sprites[key], rad=rad))

    def draw(self, layer, t):
        H = self.H
        for q in self.p:
            span = H + 4 * q["rad"]
            y = (q["y"] + q["vy"] * t) % span - 2 * q["rad"]
            x = q["x"] + q["sway"] * math.sin(TAU * t / q["per"] + q["ph"])
            _stamp(layer, q["spr"], x, y, q["gain"])


class Rain(Motion):
    """Fast, slanted streaks of rain."""

    def __init__(self, W, H, accent, light):
        super().__init__(W, H, accent, light)
        n = int(85 * self.area) + 8
        r = self.rng
        self.p = [dict(x=r.uniform(-0.2 * W, W), y=r.uniform(0, H), ln=r.uniform(40, 110) * self.u, vy=r.uniform(1300, 2000) * self.u,
                       gain=r.uniform(0.22, 0.55), th=1 if r.random() < 0.6 else 2) for _ in range(n)]
        self.color = self.col((175, 200, 230))
        self.slant = 0.13

    def draw(self, layer, t):
        H, W = self.H, self.W
        th_scale = max(1, int(round(self.u)))
        for q in self.p:
            span = H + q["ln"]
            y = (q["y"] + q["vy"] * t) % span - q["ln"]
            x = (q["x"] + self.slant * q["vy"] * t) % (1.2 * W) - 0.1 * W
            c = tuple(v * q["gain"] for v in self.color[::-1])
            cv2.line(layer, (int(x), int(y)), (int(x + self.slant * q["ln"]), int(y + q["ln"])), c, q["th"] * th_scale, cv2.LINE_AA)


class Embers(Motion):
    """Glowing sparks rising from the bottom, flickering and fading out."""

    def __init__(self, W, H, accent, light):
        super().__init__(W, H, accent, light)
        n = int(70 * self.area) + 8
        r = self.rng
        self.p = []
        for i in range(n):
            rad = r.uniform(9, 22) * self.u
            self.p.append(dict(i=i, x=r.uniform(0, W), off=r.uniform(0, 1), life=r.uniform(0.35, 0.95) * H, vy=r.uniform(70, 230) * self.u,
                               sway=r.uniform(10, 45) * self.u, per=r.uniform(2, 5), ph=r.uniform(0, TAU), flick=r.uniform(5, 11),
                               gain=r.uniform(0.75, 1.0), drift=r.uniform(-0.12, 0.12),
                               spr=_sprite_disc(rad, self.col((255, 120, 30))), core=_sprite_disc(rad * 0.4, self.col((255, 230, 180)))))

    def draw(self, layer, t):
        H, W = self.H, self.W
        for q in self.p:
            travel = q["vy"] * t + q["off"] * q["life"]
            k = math.floor(travel / q["life"])
            p = travel / q["life"] - k  # 0 → 1 over one life
            x0 = (q["x"] + _hash(k, q["i"]) * W) % W
            y = H + 10 * self.u - p * q["life"]
            x = x0 + q["sway"] * math.sin(TAU * t / q["per"] + q["ph"]) + q["drift"] * p * q["life"]
            g = q["gain"] * math.sin(math.pi * p) ** 0.7 * (0.7 + 0.3 * math.sin(TAU * q["flick"] * t + q["ph"]))
            _stamp(layer, q["spr"], x, y, g)
            _stamp(layer, q["core"], x, y, min(1.0, g * 1.4))


class Sparkles(Motion):
    """Four-pointed sparkles that twinkle in and out, in the accent colour and white."""

    def __init__(self, W, H, accent, light):
        super().__init__(W, H, accent, light)
        n = int(26 * self.area) + 6
        r = self.rng
        self.p = [dict(x=r.uniform(0.04, 0.96) * W, y=r.uniform(0.03, 0.97) * H, per=r.uniform(2.2, 5.5), ph=r.uniform(0, 1),
                       vy=r.uniform(3, 12) * self.u, gain=r.uniform(0.7, 1.0),
                       spr=_sprite_spark(r.uniform(18, 48) * self.u, self.col(self.accent if i % 2 else (255, 255, 255)))) for i in range(n)]

    def draw(self, layer, t):
        for q in self.p:
            s = math.sin(math.pi * ((t / q["per"] + q["ph"]) % 1.0))
            y = (q["y"] - q["vy"] * t) % self.H
            _stamp(layer, q["spr"], q["x"], y, q["gain"] * s ** 3)


MOTIONS = {"bokeh": Bokeh, "snow": Snow, "rain": Rain, "embers": Embers, "sparkles": Sparkles}

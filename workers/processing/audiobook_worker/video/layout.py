"""Pure layout / camera math for the read-along video. No I/O, fully unit-testable.

Coordinates: page space is PDF points (origin top-left). The camera looks at a point
(cx, cy) in page space with a scale `s` in frame pixels per point.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field

PAGE_FADE = 0.45          # seconds of cross-fade on page change
PAGE_SWITCH_LEAD = 0.30   # start the page change this long before the next page's first sentence
CAM_MOVE = 0.90           # seconds for a camera pan
CAM_LEAD = 0.35           # start panning slightly before the sentence starts
DEAD_ZONE = 0.18          # fraction of the visible height the target may drift before we pan
HL_FADE_IN = 0.12
HL_HOLD = 0.80            # keep highlight this long into a pause before fading
HL_FADE_OUT = 0.30


def smoothstep(u: float) -> float:
    u = 0.0 if u < 0 else 1.0 if u > 1 else u
    return u * u * u * (u * (6 * u - 15) + 10)  # smootherstep: zero 1st/2nd derivative at ends


def base_scale(pw: float, ph: float, W: int, H: int, animation: str) -> float:
    """Frame pixels per PDF point."""
    fit = min(W / pw, H / ph) * 0.92
    if animation == "follow":
        frac = 0.62 if W / H > 1.2 else 0.92
        return max(fit, W * frac / pw)
    return fit


def union_y(rects: list[list[float]]) -> tuple[float, float]:
    return min(r[1] for r in rects), max(r[3] for r in rects)


def clamp_center(cy: float, ph: float, visible_h: float) -> float:
    """Keep the camera over the page; if the whole page fits, center it."""
    pad = 0.04 * ph
    if ph + 2 * pad <= visible_h:
        return ph / 2
    lo, hi = visible_h / 2 - pad, ph - visible_h / 2 + pad
    return min(max(cy, lo), hi)


def target_y(rects: list[list[float]], ph: float, visible_h: float) -> float:
    if not rects:
        return ph / 2
    y0, y1 = union_y(rects)
    if y1 - y0 < 0.6 * visible_h:
        return clamp_center((y0 + y1) / 2, ph, visible_h)
    # Tall block (long sentence / paragraph): put its top at ~30% of the frame.
    return clamp_center(y0 - 0.3 * visible_h + visible_h / 2, ph, visible_h)


@dataclass
class Keyframe:
    t0: float
    y_from: float
    y_to: float
    dur: float


@dataclass
class CameraPath:
    keys: list[Keyframe] = field(default_factory=list)

    def y_at(self, t: float) -> float:
        if not self.keys:
            return 0.0
        i = bisect_right([k.t0 for k in self.keys], t) - 1
        if i < 0:
            return self.keys[0].y_from
        k = self.keys[i]
        if k.dur <= 0 or t >= k.t0 + k.dur:
            return k.y_to
        return k.y_from + (k.y_to - k.y_from) * smoothstep((t - k.t0) / k.dur)


def build_camera_path(segments: list[dict], ph: float, visible_h: float, t_start: float, follow: bool) -> CameraPath:
    """Piecewise eased vertical pan: only move when the next sentence leaves the dead zone."""
    path = CameraPath()
    if not segments or not follow:
        cy = ph / 2
        path.keys.append(Keyframe(t_start, cy, cy, 0.0))
        return path
    cur = target_y(segments[0]["rects"], ph, visible_h)
    path.keys.append(Keyframe(t_start, cur, cur, 0.0))
    for seg in segments[1:]:
        tgt = target_y(seg["rects"], ph, visible_h)
        if abs(tgt - cur) <= DEAD_ZONE * visible_h:
            continue
        t0 = max(seg["start"] - CAM_LEAD, path.keys[-1].t0 + 0.05)
        y_from = path.y_at(t0)
        path.keys.append(Keyframe(t0, y_from, tgt, CAM_MOVE))
        cur = tgt
    return path


@dataclass
class PageRun:
    page: int
    seg_from: int   # index into segments (inclusive)
    seg_to: int     # exclusive
    show_from: float
    show_to: float


def build_runs(segments: list[dict], t_start: float, t_end: float) -> list[PageRun]:
    """Group consecutive segments on the same page and decide when each page is on screen."""
    runs: list[PageRun] = []
    for i, s in enumerate(segments):
        if runs and runs[-1].page == s["page"]:
            runs[-1].seg_to = i + 1
        else:
            runs.append(PageRun(s["page"], i, i + 1, 0.0, 0.0))
    for j, r in enumerate(runs):
        if j == 0:
            r.show_from = t_start
        else:
            prev_end = segments[runs[j - 1].seg_to - 1]["end"]
            nxt_start = segments[r.seg_from]["start"]
            r.show_from = max(prev_end, nxt_start - PAGE_SWITCH_LEAD)
            runs[j - 1].show_to = r.show_from
    if runs:
        runs[-1].show_to = t_end
    return runs


def highlight_state(segments: list[dict], seg_from: int, seg_to: int, t: float) -> tuple[int | None, float, int | None, float]:
    """(current_seg, alpha, previous_seg, prev_alpha) for the page run at time t."""
    starts = [segments[i]["start"] for i in range(seg_from, seg_to)]
    k = bisect_right(starts, t) - 1
    if k < 0:
        return None, 0.0, None, 0.0
    idx = seg_from + k
    s = segments[idx]
    a = min(1.0, (t - s["start"]) / HL_FADE_IN) if HL_FADE_IN > 0 else 1.0
    hold_end = s["end"] + HL_HOLD
    if t > hold_end:
        a = max(0.0, 1.0 - (t - hold_end) / HL_FADE_OUT)
    prev, pa = None, 0.0
    if a < 1.0 and k > 0 and t - s["start"] < HL_FADE_IN:
        prev, pa = idx - 1, 1.0 - a
    return idx, a, prev, pa


def frame_range(t0: float, t1: float, fps: int) -> tuple[int, int]:
    """Global frame indices [f0, f1) — derived from absolute times so chapters never drift."""
    return int(round(t0 * fps)), int(round(t1 * fps))

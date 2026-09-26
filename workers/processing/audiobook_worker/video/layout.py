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
CAM_MOVE_MIN = 0.40       # fastest pan (big jumps with little or no pause, e.g. mid-sentence column break)
CAM_LEAD = 0.35           # start panning slightly before the sentence starts
DEAD_ZONE = 0.18          # fraction of the visible height the target may drift before we pan
EDGE = 0.04               # margin (fraction of visible height) kept between the words being read and the frame edge
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


def _inv_smoothstep(p: float) -> float:
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if smoothstep(mid) < p else (lo, mid)
    return hi


def reading_parts(segments: list[dict]) -> list[tuple[float, float, list]]:
    """(start, end, rects) camera targets in reading order. A sentence that continues at the top of
    the next column is split at the column break (time shared by printed width) so the camera can
    follow it. Paragraph highlighting repeats one paragraph's rects for each sentence: never split."""
    parts = []
    for i, seg in enumerate(segments):
        rects = seg["rects"]
        groups = [[rects[0]]] if rects else []
        for r in rects[1:]:
            last = groups[-1][-1]
            if r[1] < last[1] - 2 * max(1.0, last[3] - last[1]):  # reading jumps back up: next column
                groups.append([r])
            else:
                groups[-1].append(r)
        repeated = any(0 <= k < len(segments) and segments[k]["rects"] == rects for k in (i - 1, i + 1))
        if len(groups) < 2 or repeated:
            parts.append((seg["start"], seg["end"], rects))
            continue
        widths = [sum(max(1.0, r[2] - r[0]) for r in g) for g in groups]
        t, dur, total = seg["start"], seg["end"] - seg["start"], sum(widths)
        for g, w in zip(groups, widths):
            parts.append((t, t + dur * w / total, g))
            t += dur * w / total
    return parts


def _window(rects: list, visible_h: float) -> tuple[float, float]:
    """Camera centres that show `rects` (or their first line, if they cannot all fit) inside the frame."""
    m = EDGE * visible_h
    y0, y1 = union_y(rects) if rects else (0.0, 0.0)
    if y1 - y0 > visible_h - 2 * m:
        y0, y1 = rects[0][1], rects[0][3]
    return y1 - visible_h / 2 + m, y0 + visible_h / 2 - m


def _pan_fraction(y_from: float, y_to: float, lo: float, hi: float, leaving: bool) -> float:
    """Eased-time fraction of a pan y_from→y_to at which the camera enters (or leaves) [lo, hi]."""
    d = y_to - y_from
    if abs(d) < 1e-9:
        return 1.0 if leaving else 0.0
    edge = (lo if d < 0 else hi) if leaving else (hi if d < 0 else lo)
    p = (edge - y_from) / d
    if leaving:
        return 1.0 if p >= 1 else _inv_smoothstep(max(0.0, p))
    return 0.0 if p <= 0 else _inv_smoothstep(min(1.0, p))


def build_camera_path(segments: list[dict], ph: float, visible_h: float, t_start: float, follow: bool) -> CameraPath:
    """Piecewise eased vertical pan: only move when the next sentence leaves the dead zone.

    A pan normally starts CAM_LEAD before the sentence. When that would still show the sentence
    off-screen as it starts (a big jump, e.g. to the top of the next column), the pan starts as
    soon as the previous words are done and, if the pause is too short, runs faster (CAM_MOVE_MIN).
    """
    path = CameraPath()
    if not segments or not follow:
        cy = ph / 2
        path.keys.append(Keyframe(t_start, cy, cy, 0.0))
        return path
    parts = reading_parts(segments)
    cur = target_y(parts[0][2], ph, visible_h)
    path.keys.append(Keyframe(t_start, cur, cur, 0.0))
    prev_end, prev_rects = parts[0][1], parts[0][2]
    for start, end, rects in parts[1:]:
        tgt = target_y(rects, ph, visible_h)
        if abs(tgt - cur) > DEAD_ZONE * visible_h:
            earliest = path.keys[-1].t0 + 0.05
            t0, dur = max(start - CAM_LEAD, earliest), CAM_MOVE
            y_from = path.keys[-1].y_to
            u_in = _pan_fraction(y_from, tgt, *_window(rects, visible_h), leaving=False)
            if t0 + u_in * dur > start:  # the words would still be off-screen when they are read
                u_out = _pan_fraction(y_from, tgt, *_window(prev_rects, visible_h), leaving=True)
                t0 = max(start - u_in * dur, prev_end - u_out * dur, earliest)
                if t0 + u_in * dur > start:  # pause too short for a normal pan: go faster, centred on the pause
                    span = u_in - u_out
                    dur = min(CAM_MOVE, max(CAM_MOVE_MIN, (start - prev_end) / span if span > 1e-6 else CAM_MOVE))
                    t0 = max((prev_end + start) / 2 - (u_in + u_out) / 2 * dur, earliest)
            path.keys.append(Keyframe(t0, path.y_at(t0), tgt, dur))
            cur = tgt
        prev_end, prev_rects = end, rects
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

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
TEXT_PAD = 0.035          # "text" page fit: margin each side of the text column, fraction of its width
GLIDE = 0.12              # seconds for the word highlight to glide to the next word on the same line
GLIDE_FADE = 0.08         # cross-fade when the next word is on another line


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


def content_box(W: int, H: int, style: dict) -> tuple[int, int, int, int]:
    """(x, y, w, h) of the picture inside the frame border. The border never covers the page."""
    if style.get("frameStyle", "none") in ("none", None):
        return 0, 0, W, H
    b = max(1, int(round(float(style.get("frameWidth", 24)) * min(W, H) / 1080.0)))
    b = min(b, max(1, min(W, H) // 5))
    return b, b, W - 2 * b, H - 2 * b


def text_extents(segments: list[dict]) -> tuple[float, dict[int, tuple[float, float]]]:
    """Width of the widest printed text on any page, and each page's (x0, x1) text span, in points."""
    span: dict[int, tuple[float, float]] = {}
    for s in segments:
        for r in s["rects"]:
            x0, x1 = span.get(s["page"], (r[0], r[2]))
            span[s["page"]] = (min(x0, r[0]), max(x1, r[2]))
    return max((b - a for a, b in span.values()), default=0.0), span


def fit_scale(pw: float, ph: float, W: int, H: int, animation: str, fit: str = "auto", text_w: float = 0.0) -> float:
    """Frame pixels per PDF point for a page fit: `width` spans the frame, `text` spans it with the text."""
    if fit == "width":
        return W / pw
    if fit == "text" and text_w > 0:
        return max(W / pw, W / (text_w * (1 + 2 * TEXT_PAD)))
    return base_scale(pw, ph, W, H, animation)


def center_x(pw: float, visible_w: float, fit: str, span: tuple[float, float] | None, text_w: float) -> float:
    """Horizontal camera centre on a page. `text` fit centres the text column (left margins differ
    between left and right pages), keeping the page edge-to-edge."""
    if fit != "text" or span is None or visible_w >= pw:
        return pw / 2
    x0, x1 = span
    # A page with only short lines (a chapter's last page, a centred heading) is centred on itself.
    cx = (x0 + x1) / 2 if x1 - x0 < 0.6 * text_w else x0 + text_w / 2
    return min(max(cx, visible_w / 2), pw - visible_w / 2)


def union_y(rects: list[list[float]]) -> tuple[float, float]:
    return min(r[1] for r in rects), max(r[3] for r in rects)


def clamp_center(cy: float, ph: float, visible_h: float, pad: float = 0.04) -> float:
    """Keep the camera over the page (`pad` = how far past its top/bottom edge, as a fraction of
    its height); if the whole page fits, center it."""
    pad = pad * ph
    if ph + 2 * pad <= visible_h:
        return ph / 2
    lo, hi = visible_h / 2 - pad, ph - visible_h / 2 + pad
    return min(max(cy, lo), hi)


def target_y(rects: list[list[float]], ph: float, visible_h: float, pad: float = 0.04) -> float:
    if not rects:
        return ph / 2
    y0, y1 = union_y(rects)
    if y1 - y0 < 0.6 * visible_h:
        return clamp_center((y0 + y1) / 2, ph, visible_h, pad)
    # Tall block (long sentence / paragraph): put its top at ~30% of the frame.
    return clamp_center(y0 - 0.3 * visible_h + visible_h / 2, ph, visible_h, pad)


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


def build_camera_path(segments: list[dict], ph: float, visible_h: float, t_start: float, follow: bool, pad: float = 0.04) -> CameraPath:
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
    cur = target_y(parts[0][2], ph, visible_h, pad)
    path.keys.append(Keyframe(t_start, cur, cur, 0.0))
    prev_end, prev_rects = parts[0][1], parts[0][2]
    for start, end, rects in parts[1:]:
        tgt = target_y(rects, ph, visible_h, pad)
        lo, hi = _window(rects, visible_h)
        # Pan when the target leaves the dead zone — or when the words would not be on screen
        # (a target clamped at the page edge can sit inside the dead zone and still be cut off).
        if abs(tgt - cur) > DEAD_ZONE * visible_h or (not lo - 0.5 <= cur <= hi + 0.5 and lo <= tgt <= hi):
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


def _fade_out(seg: dict, t: float) -> float:
    hold_end = seg["end"] + HL_HOLD
    return 1.0 if t <= hold_end else max(0.0, 1.0 - (t - hold_end) / HL_FADE_OUT)


def word_index(seg: dict, t: float) -> int:
    """The word being spoken at time t (the first one before the sentence starts)."""
    starts = seg.get("_ws")
    if starts is None:
        starts = seg["_ws"] = [w["start"] for w in seg["words"]]
    return max(0, bisect_right(starts, t) - 1)


def same_line(a: list[float], b: list[float]) -> bool:
    return abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) < 0.5 * max(a[3] - a[1], b[3] - b[1], 1e-6)


def word_marks(segments: list[dict], seg_from: int, idx: int, t: float) -> list[tuple[list, float]]:
    """Word highlight at time t: [(rects, alpha)]. The box glides from the previous word when both
    are on one line (also across a sentence break), and cross-fades when reading moves to a new line."""
    seg = segments[idx]
    words = seg.get("words") or []
    if not words:
        return []
    k = word_index(seg, t)
    cur = words[k]["rects"]
    since = t - words[k]["start"]
    prev = None
    if k > 0:
        prev = words[k - 1]["rects"]
    elif idx > seg_from and segments[idx - 1].get("words") and seg["start"] - segments[idx - 1]["end"] <= HL_HOLD:
        prev = segments[idx - 1]["words"][-1]["rects"]
    out_a = _fade_out(seg, t)
    if prev is None:
        a = min(1.0, max(0.0, since) / HL_FADE_IN) if HL_FADE_IN > 0 else 1.0
        return [(cur, a * out_a)]
    if since >= GLIDE or since < 0:
        return [(cur, out_a)]
    if len(prev) == 1 and len(cur) == 1 and same_line(prev[0], cur[0]):
        u = smoothstep(since / GLIDE)
        return [([[p + (c - p) * u for p, c in zip(prev[0], cur[0])]], out_a)]
    v = min(1.0, since / GLIDE_FADE)
    return [(prev, (1.0 - v) * out_a), (cur, v * out_a)]


def _line_of(lines: list[list[float]], r: list[float]) -> int:
    """Index of the printed line (a sentence rect) that holds word rect r."""
    cy = (r[1] + r[3]) / 2
    best, dist = 0, float("inf")
    for i, ln in enumerate(lines):
        if r[2] < ln[0] - 1 or r[0] > ln[2] + 1:
            continue
        d = abs((ln[1] + ln[3]) / 2 - cy)
        if d < dist:
            best, dist = i, d
    return best


def cursor_position(seg: dict, t: float) -> tuple[int, float]:
    """(line, x) of the reading cursor at time t: it sweeps each word (and the space after it) as
    the word is spoken, so it moves continuously along a line. `line` indexes seg["rects"]."""
    words, lines = seg["words"], seg["rects"]
    k = word_index(seg, t)
    w = words[k]
    rs = [list(r) for r in w["rects"]]
    nxt = words[k + 1]["rects"][0] if k + 1 < len(words) else None
    if nxt is not None and same_line(rs[-1], nxt) and nxt[0] > rs[-1][2]:
        rs[-1][2] = nxt[0]
    dur = w["end"] - w["start"]
    u = 1.0 if dur <= 0 else min(1.0, max(0.0, (t - w["start"]) / dur))
    widths = [max(1e-6, r[2] - r[0]) for r in rs]
    pos = u * sum(widths)
    for r, wd in zip(rs, widths):
        if pos <= wd or r is rs[-1]:
            return _line_of(lines, r), r[0] + min(pos, wd)
        pos -= wd
    return len(lines) - 1, lines[-1][2]


def cursor_marks(seg: dict, t: float) -> tuple[list[list[float]], list[float] | None, float]:
    """(read rects, caret rect, alpha): the part of the sentence read so far, as line pieces."""
    if not seg.get("words") or not seg["rects"]:
        return [], None, 0.0
    line, x = cursor_position(seg, t)
    lines = seg["rects"]
    ln = lines[line]
    x = min(max(x, ln[0]), ln[2])
    read = [list(r) for r in lines[:line]] + ([[ln[0], ln[1], x, ln[3]]] if x > ln[0] else [])
    a = _fade_out(seg, t) * (min(1.0, max(0.0, t - seg["start"]) / HL_FADE_IN) if HL_FADE_IN > 0 else 1.0)
    caret = [x, ln[1], x, ln[3]] if t <= seg["end"] else None
    return read, caret, a


def frame_range(t0: float, t1: float, fps: int) -> tuple[int, int]:
    """Global frame indices [f0, f1) — derived from absolute times so chapters never drift."""
    return int(round(t0 * fps)), int(round(t1 * fps))

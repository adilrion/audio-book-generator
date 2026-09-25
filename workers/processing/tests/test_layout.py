from audiobook_worker.video import layout


def seg(start, end, page, y):
    return {"start": start, "end": end, "page": page, "rects": [[50, y, 380, y + 12]]}


def test_frame_range_no_drift():
    fps = 30
    bounds = [0.0, 12.345, 25.001, 40.9999]
    total = 0
    for a, b in zip(bounds, bounds[1:]):
        f0, f1 = layout.frame_range(a, b, fps)
        total += f1 - f0
    assert total == round(bounds[-1] * fps)


def test_runs_and_page_switch():
    segs = [seg(0, 2, 1, 100), seg(2.3, 4, 1, 300), seg(4.3, 6, 2, 100)]
    runs = layout.build_runs(segs, 0.0, 7.0)
    assert [r.page for r in runs] == [1, 2]
    assert runs[0].show_from == 0.0 and runs[1].show_to == 7.0
    # switch happens in the pause, never before the previous sentence ends
    assert 4.0 <= runs[1].show_from <= 4.3
    assert runs[0].show_to == runs[1].show_from


def test_camera_dead_zone_and_pan():
    ph, vis = 648.0, 300.0
    segs = [seg(0, 2, 1, 100), seg(2.3, 4, 1, 110), seg(4.3, 6, 1, 500)]
    path = layout.build_camera_path(segs, ph, vis, 0.0, follow=True)
    assert len(path.keys) == 2  # small move ignored, big move panned
    y_start = path.y_at(0.5)
    y_end = path.y_at(10)
    assert y_end > y_start
    # target sentence visible after the pan
    assert abs(y_end - 506) <= vis / 2
    # monotonic eased motion
    ys = [path.y_at(3.9 + i * 0.1) for i in range(12)]
    assert all(b >= a - 1e-9 for a, b in zip(ys, ys[1:]))


def test_clamp_center_small_page():
    assert layout.clamp_center(10, 100, 500) == 50


def test_highlight_state_fades():
    segs = [seg(0, 2, 1, 100), seg(2.3, 4, 1, 200)]
    cur, a, prev, pa = layout.highlight_state(segs, 0, 2, 1.0)
    assert cur == 0 and a == 1.0 and prev is None
    cur, a, prev, pa = layout.highlight_state(segs, 0, 2, 2.35)
    assert cur == 1 and 0 < a < 1 and prev == 0 and pa > 0
    cur, a, *_ = layout.highlight_state(segs, 0, 2, 10.0)
    assert cur == 1 and a == 0.0  # faded out during a long pause
    cur, a, *_ = layout.highlight_state(segs, 0, 2, -1)
    assert cur is None


def test_base_scale_follow_is_readable():
    s_follow = layout.base_scale(432, 648, 1920, 1080, "follow")
    s_fit = layout.base_scale(432, 648, 1920, 1080, "static")
    assert s_follow > s_fit
    assert 648 * s_fit <= 1080

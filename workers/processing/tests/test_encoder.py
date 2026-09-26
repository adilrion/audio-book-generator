import json
import os
import shutil
import subprocess
import time

import numpy as np
import pytest

from audiobook_worker.errors import WorkerError
from audiobook_worker.util import atomic_path
from audiobook_worker.video.encoder import FrameWriter, available_encoders

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _frames(n, w, h):
    for i in range(n):
        f = np.full((h, w, 3), (i * 9) % 250, np.uint8)
        f[:, (i * 7) % w] = 255
        yield f


def test_ffmpeg_failure_surfaces_stderr_and_leaves_no_files(tmp_path):
    if "libx264" not in available_encoders("ffmpeg"):
        pytest.skip("libx264 not available")
    out = tmp_path / "odd.mp4"
    with pytest.raises(WorkerError) as e:
        with atomic_path(out) as tmp:
            w = FrameWriter(tmp, 321, 181, 30, "libx264")  # yuv420p needs even dimensions
            try:
                for f in _frames(10, 321, 181):
                    w.write(f.data)
                w.close()
            except BaseException:
                w.abort()
                raise
    assert e.value.code == "FFMPEG_FAILED"
    assert "divisible by 2" in e.value.details["stderr"]
    assert os.listdir(tmp_path) == []  # no temp video, no stderr log left behind


def test_abort_kills_and_reaps_ffmpeg(tmp_path):
    w = FrameWriter(str(tmp_path / "a.mp4"), 320, 180, 30)
    for f in _frames(5, 320, 180):
        w.write(f.data)
    w.abort()
    assert w.proc.returncode is not None  # killed and reaped, not a zombie
    assert not any(p.endswith(".log") for p in os.listdir(tmp_path))


def _count(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                          "stream=nb_read_frames,duration", "-of", "json", path], capture_output=True, text=True, check=True)
    st = json.loads(out.stdout)["streams"][0]
    return int(st["nb_read_frames"]), float(st["duration"])


@pytest.mark.parametrize("codec", ["auto", "libx264"])
def test_segments_concat_with_stream_copy_frame_exact(tmp_path, codec):
    """Chapter segments are joined with the concat demuxer + `-c copy` (muxFinal): the result must
    have exactly the sum of the frames and duration — otherwise audio drifts chapter by chapter."""
    if codec != "auto" and codec not in available_encoders("ffmpeg"):
        pytest.skip(f"{codec} not available")
    counts, fps, paths = [31, 47, 29], 30, []
    for k, n in enumerate(counts):
        p = str(tmp_path / f"s{k}.mp4")
        w = FrameWriter(p, 320, 180, fps, codec, "1M")
        for f in _frames(n, 320, 180):
            w.write(f.data)
        w.close()
        assert _count(p)[0] == n
        paths.append(p)
    lst = tmp_path / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in paths))
    out = str(tmp_path / "all.mp4")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-c:v", "copy", out], check=True)
    frames, duration = _count(out)
    assert frames == sum(counts)
    assert abs(duration - sum(counts) / fps) < 1e-3


def test_stale_temp_files_of_killed_renders_are_swept(tmp_path, sample_pdf):
    """A cancelled job SIGKILLs the worker; ffmpeg then finishes the partial temp file. The next
    render into the same directory removes such stale temp files (but never fresh ones)."""
    from test_video import _params, Ctx
    from audiobook_worker.video.render_chapter import render_chapter

    p = _params(sample_pdf, tmp_path)
    out_dir = os.path.dirname(p["outPath"])
    stale = [os.path.join(out_dir, n) for n in (".old.mp4.k2j3h4.mp4", ".old.mp4.k2j3h4.mp4.log")]
    fresh = os.path.join(out_dir, ".busy.mp4.a1b2c3.mp4")
    for f in stale + [fresh]:
        with open(f, "wb") as fh:
            fh.write(b"x" * 100)
    old = time.time() - 7200
    for f in stale:
        os.utime(f, (old, old))
    other = os.path.join(out_dir, "keep.txt")
    open(other, "w").close()
    os.utime(other, (old, old))
    render_chapter(p, Ctx())
    assert not any(os.path.exists(f) for f in stale)
    assert os.path.exists(fresh) and os.path.exists(other)

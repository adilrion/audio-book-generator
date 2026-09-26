"""FFmpeg raw-frame pipe encoder with Apple VideoToolbox hardware encoding."""
from __future__ import annotations

import collections
import functools
import subprocess
import threading

from ..errors import WorkerError


@functools.lru_cache(maxsize=4)
def available_encoders(ffmpeg: str) -> frozenset[str]:
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired) as e:
        raise WorkerError("FFMPEG_MISSING", "FFmpeg is not installed or not runnable.", {"hint": "brew install ffmpeg", "reason": str(e)})
    names = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and len(parts[0]) == 6:
            names.add(parts[1])
    return frozenset(names)


def pick_video_codec(ffmpeg: str, requested: str = "auto") -> str:
    enc = available_encoders(ffmpeg)
    if requested != "auto":
        if requested not in enc:
            raise WorkerError("FFMPEG_ENCODER_MISSING", f"FFmpeg encoder '{requested}' is not available.")
        return requested
    for c in ("h264_videotoolbox", "libx264"):
        if c in enc:
            return c
    raise WorkerError("FFMPEG_ENCODER_MISSING", "No H.264 encoder found in FFmpeg.", {"hint": "brew reinstall ffmpeg"})


def video_codec_args(codec: str, fps: int, bitrate: str, crf: int) -> list[str]:
    gop = str(int(fps * 2))
    if codec == "h264_videotoolbox":
        # Hardware media engine: fast, very low CPU. Bitrate-controlled.
        return ["-c:v", codec, "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate, "-profile:v", "high",
                "-allow_sw", "1", "-g", gop]
    return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", str(crf), "-profile:v", "high", "-g", gop]


class FrameWriter:
    def __init__(self, out_path: str, width: int, height: int, fps: int, codec: str = "auto",
                 bitrate: str = "6M", crf: int = 20, ffmpeg: str = "ffmpeg"):
        self.codec = pick_video_codec(ffmpeg, codec)
        self.out_path = out_path
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-framerate", str(fps), "-i", "-",
               "-an", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
               *video_codec_args(self.codec, fps, bitrate, crf),
               "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
               "-video_track_timescale", str(fps * 1000), "-f", "mp4", out_path]
        # stderr is drained by a thread into a bounded tail: no log file to leave behind, no pipe deadlock
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=width * height * 3)
        self._err: collections.deque[bytes] = collections.deque(maxlen=64)
        self._err_reader = threading.Thread(target=self._drain_stderr, daemon=True)
        self._err_reader.start()
        self.frames = 0

    def _drain_stderr(self) -> None:
        for line in iter(self.proc.stderr.readline, b""):
            self._err.append(line)

    def write(self, frame_bytes) -> None:
        try:
            self.proc.stdin.write(frame_bytes)
            self.frames += 1
        except BrokenPipeError:
            self._fail()

    def _fail(self):
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self._err_reader.join(timeout=5)
        err = b"".join(self._err)[-2000:].decode("utf-8", "replace")
        raise WorkerError("FFMPEG_FAILED", "Video encoding failed.", {"stderr": err, "codec": self.codec}, retryable=True)

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        code = self.proc.wait()
        if code != 0:
            self._fail()
        self._err_reader.join(timeout=5)

    def abort(self) -> None:
        """Kill ffmpeg and reap it (no zombie; the partial output is removed by atomic_path)."""
        try:
            self.proc.kill()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass

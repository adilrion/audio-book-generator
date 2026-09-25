"""FFmpeg raw-frame pipe encoder with Apple VideoToolbox hardware encoding."""
from __future__ import annotations

import functools
import os
import subprocess

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
        self._stderr_path = out_path + ".log"
        self._stderr = open(self._stderr_path, "wb")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=self._stderr, bufsize=width * height * 3)
        self.frames = 0

    def write(self, frame_bytes) -> None:
        try:
            self.proc.stdin.write(frame_bytes)
            self.frames += 1
        except BrokenPipeError:
            self._fail()

    def _fail(self):
        self.proc.wait(timeout=10)
        self._stderr.close()
        with open(self._stderr_path, "rb") as fh:
            err = fh.read()[-2000:].decode("utf-8", "replace")
        raise WorkerError("FFMPEG_FAILED", "Video encoding failed.", {"stderr": err, "codec": self.codec}, retryable=True)

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        code = self.proc.wait()
        if code != 0:
            self._fail()
        self._stderr.close()
        try:
            os.unlink(self._stderr_path)
        except FileNotFoundError:
            pass

    def abort(self) -> None:
        try:
            self.proc.kill()
        finally:
            self._stderr.close()

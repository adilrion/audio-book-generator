"""JSON-lines RPC server.

Protocol (one JSON object per line):
  request:  {"id": 1, "method": "pdf.extract", "params": {...}}
  event:    {"id": 1, "event": "progress", "data": {...}}   (0..n per request)
  response: {"id": 1, "result": {...}}  or  {"id": 1, "error": {"code", "message", "details"}}

stdout is reserved for the protocol; anything else libraries print goes to stderr.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any, Callable

from .errors import WorkerError


class Context:
    def __init__(self, req_id: Any, send: Callable[[dict], None]):
        self.req_id = req_id
        self._send = send
        self._last_emit = 0.0

    def progress(self, done: float, total: float, message: str | None = None, force: bool = False, **extra) -> None:
        now = time.monotonic()
        if not force and now - self._last_emit < 0.25 and done < total:
            return
        self._last_emit = now
        data = {"done": done, "total": total, **extra}
        if message:
            data["message"] = message
        self._send({"id": self.req_id, "event": "progress", "data": data})

    def log(self, message: str) -> None:
        self._send({"id": self.req_id, "event": "log", "data": {"message": message}})


def _methods() -> dict[str, Callable[[dict, Context], Any]]:
    # Imported lazily so a missing optional dependency only breaks the methods that need it.
    from .pdf import extract as pdf_extract
    from .pdf import inspect as pdf_inspect
    from .pdf import render as pdf_render
    from .tts import service as tts_service
    from .video import render_chapter as video_render
    from . import system

    return {
        "ping": lambda p, c: {"pong": True, "pid": os.getpid()},
        "system.info": system.info,
        "pdf.inspect": pdf_inspect.inspect_rpc,
        "pdf.extract": pdf_extract.extract_rpc,
        "pdf.render_pages": pdf_render.render_pages_rpc,
        "pdf.render_preview": pdf_render.render_preview_rpc,
        "tts.engines": tts_service.engines_rpc,
        "tts.voices": tts_service.voices_rpc,
        "tts.synthesize": tts_service.synthesize_rpc,
        "tts.synthesize_chapter": tts_service.synthesize_chapter_rpc,
        "video.render_chapter": video_render.render_chapter_rpc,
    }


def main() -> None:
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def send(obj: dict) -> None:
        proto.write(json.dumps(obj, separators=(",", ":")) + "\n")
        proto.flush()

    methods = _methods()
    send({"event": "ready", "data": {"pid": os.getpid()}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            fn = methods.get(method)
            if fn is None:
                raise WorkerError("UNKNOWN_METHOD", f"Unknown method: {method}")
            result = fn(req.get("params") or {}, Context(req_id, send))
            send({"id": req_id, "result": result})
        except WorkerError as e:
            send({"id": req_id, "error": e.to_dict()})
        except MemoryError:
            send({"id": req_id, "error": {"code": "OUT_OF_MEMORY", "message": "Worker ran out of memory", "retryable": True}})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            send({"id": req_id, "error": {"code": "WORKER_EXCEPTION", "message": str(e) or e.__class__.__name__,
                                          "details": {"type": e.__class__.__name__, "trace": traceback.format_exc()[-4000:]},
                                          "retryable": True}})


if __name__ == "__main__":
    main()

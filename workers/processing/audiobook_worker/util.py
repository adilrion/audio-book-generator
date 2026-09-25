from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def atomic_path(final_path: str | os.PathLike, suffix: str = ""):
    """Yield a temp path next to `final_path`; rename into place only on success."""
    final = Path(final_path)
    final.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{final.name}.", suffix=suffix or final.suffix, dir=final.parent)
    os.close(fd)
    try:
        yield tmp
        os.replace(tmp, final)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def which(binary: str) -> str | None:
    return shutil.which(binary)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default

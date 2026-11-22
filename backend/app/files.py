"""Every write the app makes outside its own database goes through here: PROGRESS.md, COACH.md, math/log.md.

- Rewrites are atomic (temp file + os.replace) and are retried if someone else saved the file in between.
- Appends use append mode, so they never rewrite what is already there.
- Each write is remembered, so the repo watcher can tell the app's own saves from the user's work,
  and logged as an `external_write` event, so it is visible what the app has changed on disk.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("ctu.files")

_own: dict[str, tuple[int, float]] = {}   # resolved path -> (mtime_ns after our write, when)
OWN_WINDOW_SEC = 30


def _remember(p: Path) -> None:
    try:
        _own[str(p.resolve())] = (p.stat().st_mtime_ns, time.monotonic())
    except OSError:
        pass
    for k, (_, t) in list(_own.items()):
        if time.monotonic() - t > OWN_WINDOW_SEC:
            _own.pop(k, None)


def is_own_write(path: str | Path) -> bool:
    """True if the file is exactly as the app last wrote it (a watcher event caused by the app itself)."""
    p = Path(path)
    hit = _own.get(str(p.resolve()))
    if not hit:
        return False
    try:
        return p.stat().st_mtime_ns == hit[0]
    except OSError:
        return False


def _record(p: Path, action: str) -> None:
    try:
        from . import db
        from .config import today
        db.ex("INSERT INTO events(ts,date,task_id,type,data) VALUES(?,?,?,?,?)",
              (db.ts(), today().isoformat(), None, "external_write", json.dumps({"file": str(p), "action": action})))
    except Exception:  # noqa: BLE001 - the log is a convenience, never a reason for a write to fail
        log.exception("could not log external write to %s", p)


def _mtime(p: Path) -> int | None:
    try:
        return p.stat().st_mtime_ns
    except FileNotFoundError:
        return None


def rewrite(p: Path, change: Callable[[str | None], str], action: str = "rewrite", attempts: int = 4) -> None:
    """Read the file, apply `change` (it gets None when the file doesn't exist), write the result atomically.
    If the file changes between the read and the replace (an editor or another tool saved it), start over
    from the new content instead of overwriting it."""
    p.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(attempts):
        before = _mtime(p)
        old = p.read_text() if before is not None else None
        new = change(old)
        fd, tmp = tempfile.mkstemp(prefix=f".{p.name}.", suffix=".tmp", dir=p.parent)
        try:
            with os.fdopen(fd, "w") as f:
                f.write(new)
                f.flush()
                os.fsync(f.fileno())
            if before is not None:
                os.chmod(tmp, p.stat().st_mode & 0o7777)
            if _mtime(p) != before:
                continue   # someone saved in between: redo from their version
            os.replace(tmp, p)
            tmp = ""
        finally:
            if tmp:
                Path(tmp).unlink(missing_ok=True)
        _remember(p)
        _record(p, action)
        return
    raise RuntimeError(f"{p} kept changing while the app tried to update it; try again.")


def append(p: Path, text: str, action: str = "append") -> None:
    """Add text at the end without rewriting the file. Starts on a new line if the file doesn't end with one."""
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a+") as f:
        f.seek(0, os.SEEK_END)
        if f.tell() > 0:
            f.seek(f.tell() - 1)
            if f.read(1) != "\n":
                text = "\n" + text
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    _remember(p)
    _record(p, action)

"""The .env file: where the AI keys live. Keys entered in Settings are written here, and every request reads them
from here, so a key added by hand in the file and one added in the app are the same thing.

One variable per provider holds all of that provider's keys, comma separated, tried in that order:
    GROQ_API_KEY=gsk_first,gsk_second
A key added in Settings goes to the end of its line; the line is created (and the file, readable by this user only)
when there is none yet. Everything else in the file, comments included, is left exactly as it was.

CTU_ENV_FILE points somewhere else (the tests and the demo use their own copy); the packaged program keeps the file
in the data folder (app/paths.py)."""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path

from .paths import env_file

_lock = threading.Lock()
_cache: tuple[float, dict[str, str]] | None = None
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def path() -> Path:
    return env_file()


def _unquote(v: str) -> str:
    v = re.sub(r"\s+#.*$", "", v) if not v[:1] in "\"'" else v  # an unquoted value may carry a trailing comment
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def values() -> dict[str, str]:
    """The file's variables (commented lines skipped). Re-read when the file changes, so a hand edit counts at once."""
    global _cache
    p = path()
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return {}
    if _cache and _cache[0] == mtime:
        return _cache[1]
    out: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        m = _LINE.match(line)
        if m and not line.lstrip().startswith("#"):
            out[m.group(1)] = _unquote(m.group(2))
    _cache = (mtime, out)
    return out


def get(name: str) -> str:
    """The file's value, else the process environment's (a variable set outside the file still counts)."""
    v = values()
    return v[name] if name in v else os.environ.get(name, "")


def split(value: str) -> list[str]:
    return [k.strip() for k in (value or "").split(",") if k.strip()]


def _write(lines: list[str]) -> None:
    global _cache
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")
    if p.exists():
        os.chmod(tmp, p.stat().st_mode & 0o777)
    os.replace(tmp, p)
    _cache = None


def _lines() -> list[str]:
    try:
        return path().read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


def set_list(name: str, items: list[str]) -> None:
    """Rewrite the one line that holds `name` (the last uncommented one, as dotenv reads it); add it at the end when
    missing, drop it when `items` is empty. os.environ follows, so code reading the environment sees the change."""
    with _lock:
        lines = _lines()
        at = None
        for i, line in enumerate(lines):
            m = _LINE.match(line)
            if m and m.group(1) == name and not line.lstrip().startswith("#"):
                at = i
        new = f"{name}={','.join(items)}"
        if at is not None:
            if items:
                lines[at] = new
            else:
                del lines[at]
        elif items:
            if lines and lines[-1].strip():
                lines.append("")
            lines.append(new)
        _write(lines)
    if items:
        os.environ[name] = ",".join(items)
    else:
        os.environ.pop(name, None)


def set_value(name: str, value: str) -> None:
    set_list(name, [value] if value else [])

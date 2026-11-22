"""The user's own API key, entered in the app (Settings → AI key) instead of a .env file.

It is kept in the data folder as `api-key` (readable by this user only) and never goes into a backup file: the backup
takes only the files it names. A key from the environment or .env wins; the app then shows where it comes from and
leaves it alone."""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from . import state
from .config import DATA_DIR

log = logging.getLogger("ctu.keys")

ENV = "ANTHROPIC_API_KEY"
SHAPE = re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,200}")
_from_app = False   # True when os.environ[ENV] was put there by load() or save()


def path() -> Path:
    return DATA_DIR / "api-key"


def _read() -> str:
    try:
        return path().read_text().strip()
    except OSError:
        return ""


def load() -> None:
    """At startup: use the key saved in the app unless the environment already has one."""
    global _from_app
    if os.environ.get(ENV) or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return
    k = _read()
    if SHAPE.fullmatch(k):
        os.environ[ENV] = k
        _from_app = True


def info() -> dict:
    k = os.environ.get(ENV) or ""
    source = ("app" if _from_app else "env") if (k or os.environ.get("ANTHROPIC_AUTH_TOKEN")) else None
    return {"set": source is not None, "source": source, "hint": f"…{k[-4:]}" if k else "",
            "free_mode": os.environ.get("CTU_LLM") == "gemini"}


async def _works(k: str) -> str | None:
    """None when Anthropic accepts the key, else what went wrong."""
    import anthropic
    try:
        await anthropic.AsyncAnthropic(api_key=k, timeout=20.0).models.list(limit=1)
        return None
    except anthropic.AuthenticationError:
        return "Anthropic doesn't accept this key."
    except anthropic.PermissionDeniedError:
        return "This key isn't allowed to use the API."
    except Exception as e:  # noqa: BLE001 - offline, DNS, timeout
        return f"Couldn't reach Anthropic to check the key ({type(e).__name__})."


async def save(k: str) -> dict:
    global _from_app
    k = (k or "").strip()
    if info()["source"] == "env":
        raise state.Refused("The key comes from .env or the environment; change it there.")
    if not SHAPE.fullmatch(k):
        raise state.Refused("That doesn't look like an Anthropic API key (it starts with sk-ant-).")
    err = await _works(k)
    if err:
        raise state.Refused(err)
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(".api-key.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(k + "\n")
    os.replace(tmp, p)
    os.environ[ENV] = k
    _from_app = True
    _reset_client()
    return info()


def remove() -> dict:
    global _from_app
    if info()["source"] == "env":
        raise state.Refused("The key comes from .env or the environment; remove it there.")
    path().unlink(missing_ok=True)
    if _from_app:
        os.environ.pop(ENV, None)
        _from_app = False
    _reset_client()
    return info()


def _reset_client() -> None:
    from . import llm
    llm._client = None

"""Problems the user should see instead of having them disappear into a log: a failed close step, a
missing COACH.md, a changed protected section, a stopped watcher, the curriculum running out."""
from __future__ import annotations

import logging

from . import bus, db

log = logging.getLogger("ctu.health")


def warn(key: str, message: str) -> None:
    """Show `message` until clear(key). Repeating the same warning doesn't notify again."""
    ws = db.kv_get("warnings", {}) or {}
    if ws.get(key, {}).get("message") == message:
        return
    ws[key] = {"message": message, "ts": db.ts()}
    db.kv_set("warnings", ws)
    log.warning("%s: %s", key, message)
    bus.publish("warning", {"key": key, "message": message})
    from . import notices
    notices.safe_add("warning", "Needs attention", message, tone="err", link="#/settings")


def clear(key: str) -> None:
    ws = db.kv_get("warnings", {}) or {}
    if key in ws:
        ws.pop(key)
        db.kv_set("warnings", ws)
        bus.publish("warning", {"key": key, "cleared": True})


def clear_prefix(prefix: str) -> None:
    ws = db.kv_get("warnings", {}) or {}
    keys = [k for k in ws if k.startswith(prefix)]
    if keys:
        for k in keys:
            ws.pop(k)
        db.kv_set("warnings", ws)
        bus.publish("warning", {"key": prefix, "cleared": True})


def warnings() -> dict:
    return db.kv_get("warnings", {}) or {}

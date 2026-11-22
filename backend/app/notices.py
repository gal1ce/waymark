"""The notification history: what the app told the user, kept so it can be read again later.

Server-side events that matter (a new sticking point, a day closed or failing to close, a problem that needs
attention) are recorded here as they happen; the browser adds the warnings and errors it showed. Each one is
also pushed to open tabs as a `notice` event, which is what shows the toast."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from . import bus, db

TONES = ("info", "ok", "warn", "err")
KEEP = 500                  # older notices are dropped
MERGE_SEC = 6               # sticking points arriving together (a graded test) become one notice


def _row(r: dict) -> dict:
    out = dict(r)
    out["read"] = bool(r["read"])
    try:
        out["items"] = json.loads(r["items"]) if r.get("items") else []
    except json.JSONDecodeError:
        out["items"] = []
    return out


def add(kind: str, title: str, body: str = "", tone: str = "info", link: str | None = None, source: str = "app") -> dict:
    tone = tone if tone in TONES else "info"
    title, body = title.strip()[:200], body.strip()[:1000]
    if not title:
        raise ValueError("a notice needs a title")
    if kind == "stuck":
        last = db.q1("SELECT * FROM notices ORDER BY id DESC LIMIT 1")
        if last and last["kind"] == "stuck" and not last["read"] and \
                datetime.fromisoformat(db.ts()) - datetime.fromisoformat(last["ts"]) <= timedelta(seconds=MERGE_SEC):
            items = (json.loads(last["items"]) if last["items"] else [last["body"]]) + [body]
            db.ex("UPDATE notices SET ts=?, title=?, body=?, items=? WHERE id=?",
                  (db.ts(), f"{len(items)} new sticking points", "They go into tomorrow's plan.", json.dumps(items, ensure_ascii=False), last["id"]))
            row = _row(db.q1("SELECT * FROM notices WHERE id=?", (last["id"],)))
            bus.publish("notice", row)
            return row
    # the same thing again while the first is still unread: move it to the top instead of a second row
    same = db.q1("SELECT * FROM notices WHERE read=0 AND kind=? AND title=? AND body=? ORDER BY id DESC LIMIT 1", (kind[:40], title, body))
    if same and datetime.fromisoformat(db.ts()) - datetime.fromisoformat(same["ts"]) <= timedelta(minutes=10):
        db.ex("UPDATE notices SET ts=? WHERE id=?", (db.ts(), same["id"]))
        row = _row(db.q1("SELECT * FROM notices WHERE id=?", (same["id"],)))
        bus.publish("notices", {})
        return row
    nid = db.ex("INSERT INTO notices(ts, kind, tone, title, body, link, source, read) VALUES(?,?,?,?,?,?,?,0)",
                (db.ts(), kind[:40], tone, title, body, link, source))
    db.ex("DELETE FROM notices WHERE id <= ?", (nid - KEEP,))
    row = _row(db.q1("SELECT * FROM notices WHERE id=?", (nid,)))
    bus.publish("notice", row)
    return row


def safe_add(*a: Any, **k: Any) -> None:
    """For hooks inside other work: a notice that can't be written never breaks that work."""
    try:
        add(*a, **k)
    except Exception:  # noqa: BLE001
        pass


def listing(limit: int = 100) -> dict:
    rows = [_row(r) for r in db.q("SELECT * FROM notices ORDER BY id DESC LIMIT ?", (max(1, min(limit, KEEP)),))]
    unread = db.q1("SELECT COUNT(*) AS n FROM notices WHERE read=0")["n"]
    return {"notices": rows, "unread": unread}


def mark_read(nid: int | None = None) -> None:
    if nid is None:
        db.ex("UPDATE notices SET read=1 WHERE read=0")
    else:
        db.ex("UPDATE notices SET read=1 WHERE id=?", (nid,))
    bus.publish("notices", {"changed": True})


def delete(nid: int | None = None) -> None:
    if nid is None:
        db.ex("DELETE FROM notices")
    else:
        db.ex("DELETE FROM notices WHERE id=?", (nid,))
    bus.publish("notices", {"changed": True})

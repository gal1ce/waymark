"""The personal notebook: pages the user writes (Markdown + LaTeX text, function graphs, images, drawings and
arrows between them). The app never reads them for planning; they're the user's own.

A page is either a document (blocks top to bottom, any of which can be a canvas) or a whole-page canvas.
The body is stored as JSON and only checked for size and shape, not interpreted."""
from __future__ import annotations

import json
import re
import secrets
from pathlib import Path

from . import db, state
from .config import DB_PATH, now
from datetime import timedelta

KINDS = ("doc", "canvas")
MAX_BODY = 4_000_000            # characters of JSON per page
MAX_ASSET = 12 * 1024 * 1024    # bytes per image
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
_NAME = re.compile(r"[0-9a-f]{24}\.(png|jpg|gif|webp)")


def assets_dir() -> Path:
    """Next to the database, so the demo's copies and the tests' throwaway folders get their own."""
    return DB_PATH.parent / "notes"


def _empty(kind: str) -> dict:
    if kind == "canvas":
        return {"canvas": {"items": [], "arrows": [], "strokes": []}}
    return {"blocks": [{"id": secrets.token_hex(4), "type": "text", "md": ""}]}


def _row(r: dict, body: bool) -> dict:
    out = {k: r[k] for k in ("id", "title", "kind", "created_at", "updated_at")} | {"topic": r.get("topic") or ""}
    if body:
        try:
            out["body"] = json.loads(r["body"])
        except json.JSONDecodeError:
            out["body"] = _empty(r["kind"])
    return out


def _blank(r: dict) -> bool:
    """No title of its own and nothing on it: a page that was opened and left."""
    if (r["title"] or "").strip() not in ("", "Untitled"):
        return False
    try:
        b = json.loads(r["body"])
    except json.JSONDecodeError:
        return False
    if "canvas" in b:
        c = b["canvas"]
        return not (c.get("items") or c.get("strokes") or c.get("arrows"))
    return all(x.get("type") == "text" and not (x.get("md") or "").strip() for x in b.get("blocks", []))


def pages() -> list[dict]:
    # blank pages left behind (a tab closed on a new page) are cleared once they're a few minutes old
    old = (now() - timedelta(minutes=5)).isoformat(timespec="seconds")
    for r in db.q("SELECT id, title, body FROM notes_pages WHERE updated_at < ?", (old,)):
        if _blank(r):
            db.ex("DELETE FROM notes_pages WHERE id=?", (r["id"],))
    return [_row(r, False) | {"preview": _preview(r["body"])} for r in
            db.q("SELECT id, title, kind, topic, body, created_at, updated_at FROM notes_pages ORDER BY updated_at DESC, id DESC")]


def _fold(s: str) -> str:
    return " ".join((s or "").lower().split())


def about(topic: str) -> list[dict]:
    """Pages whose topic matches (either one contains the other: 'Limits' and 'Limits & Continuity'), newest first."""
    k = _fold(topic)
    if not k:
        return []
    return [_row(r, False) for r in db.q("SELECT id, title, kind, topic, created_at, updated_at FROM notes_pages "
                                         "WHERE topic<>'' ORDER BY updated_at DESC")
            if (t := _fold(r["topic"])) and (t in k or k in t)]


def topic_choices() -> list[str]:
    """What a page can be about: the plan's units and the topics tests have asked about, plus topics already used."""
    from . import profile
    seen: dict[str, str] = {}
    for tr in profile.tracks() if not profile.is_ctu() else []:
        for u in tr.get("units") or []:
            seen.setdefault(_fold(u.get("title", "")), u.get("title", ""))
    for r in db.q("SELECT results FROM tests WHERE status='submitted' AND results IS NOT NULL ORDER BY id DESC LIMIT 60"):
        for x in json.loads(r["results"] or "[]"):
            if x.get("topic"):
                seen.setdefault(_fold(x["topic"]), x["topic"])
    for r in db.q("SELECT DISTINCT topic FROM notes_pages WHERE topic<>''"):
        seen.setdefault(_fold(r["topic"]), r["topic"])
    return [v for k, v in seen.items() if k][:200]


def _preview(raw: str) -> str:
    """The first words of the first text on the page, for the list."""
    try:
        b = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    texts: list[str] = []
    for blk in b.get("blocks", []):
        if blk.get("type") == "text":
            texts.append(blk.get("md", ""))
        elif blk.get("type") == "canvas":
            texts += [i.get("md", "") for i in blk.get("items", []) if i.get("type") == "text"]
    texts += [i.get("md", "") for i in b.get("canvas", {}).get("items", []) if i.get("type") == "text"]
    s = " ".join(t for t in texts if t).replace("\n", " ")
    return re.sub(r"\s+", " ", re.sub(r"[#*_`>$\\]", "", s)).strip()[:140]


def get(pid: int) -> dict:
    r = db.q1("SELECT * FROM notes_pages WHERE id=?", (pid,))
    if not r:
        raise state.Refused("That page doesn't exist.")
    return _row(r, True)


def create(title: str, kind: str) -> dict:
    if kind not in KINDS:
        raise state.Refused("A page is a document or a canvas.")
    t = db.ts()
    pid = db.ex("INSERT INTO notes_pages(title, kind, body, created_at, updated_at) VALUES(?,?,?,?,?)",
                ((title or "").strip()[:200] or "Untitled", kind, json.dumps(_empty(kind)), t, t))
    return get(pid)


def save(pid: int, title: str | None, body: dict | None, topic: str | None = None) -> dict:
    get(pid)
    sets, args = [], []
    if topic is not None:
        sets.append("topic=?")
        args.append(" ".join(topic.split())[:120])
    if title is not None:
        sets.append("title=?")
        args.append(title.strip()[:200] or "Untitled")
    if body is not None:
        if not isinstance(body, dict) or not ({"blocks", "canvas"} & body.keys()):
            raise state.Refused("The page body has no blocks or canvas.")
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        if len(raw) > MAX_BODY:
            raise state.Refused("The page is too big to save (move large images to their own page).")
        sets.append("body=?")
        args.append(raw)
    if sets:
        db.ex(f"UPDATE notes_pages SET {', '.join(sets)}, updated_at=? WHERE id=?", (*args, db.ts(), pid))
    return {k: v for k, v in get(pid).items() if k != "body"}


def delete(pid: int) -> None:
    get(pid)
    db.ex("DELETE FROM notes_pages WHERE id=?", (pid,))


def save_asset(data: bytes, content_type: str) -> str:
    ext = IMAGE_TYPES.get((content_type or "").split(";")[0].strip().lower())
    if not ext:
        raise state.Refused("Only PNG, JPEG, GIF and WebP images can be added.")
    if not data:
        raise state.Refused("The image is empty.")
    if len(data) > MAX_ASSET:
        raise state.Refused("The image is larger than 12 MB.")
    d = assets_dir()
    d.mkdir(parents=True, exist_ok=True)
    name = f"{secrets.token_hex(12)}.{ext}"
    (d / name).write_bytes(data)
    return name


def asset_path(name: str) -> Path:
    if not _NAME.fullmatch(name):
        raise state.Refused("No such image.")
    p = assets_dir() / name
    if not p.is_file():
        raise state.Refused("No such image.")
    return p

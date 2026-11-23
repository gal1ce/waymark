"""Khan Academy inside the app, through Kolibri.

Kolibri (Learning Equality's offline platform; Khan Academy's partner for offline use) downloads the
Khan Academy US channel: one metadata database plus, unit by unit, the low-res videos, their subtitles
and the exercise packages (Perseus). The app reads those files:

- videos play in the app (local mp4, English/Turkish subtitles);
- exercises run in the app with Khan's own items and hints, checked here; an exercise is mastered at
  5 right out of the last 7 first tries (Khan's and Kolibri's rule);
- the unit test is drawn from the unit's items, graded here, and the score is saved like a typed one
  (scores, cursor, math/log.md);
- items the app can't show (graphing, drag and drop) open in Kolibri's own player on localhost.

Nothing here talks to khanacademy.org.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import shutil
import sqlite3
import threading
import time
import zipfile
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

from . import db, health, perseus, state
from .config import KOLIBRI_BIN, KOLIBRI_HOME, KOLIBRI_URL, today
from .curriculum import KHAN_UNITS, khan_unit

log = logging.getLogger("ctu.khan")

CHANNEL = "c9d7f950ab6b5a1199e3d6c10d7f0103"     # Khan Academy (English - US curriculum)
SUBTITLE_LANGS = {"en": "English", "tr": "Türkçe"}
VIDEO_PRESETS = ("low_res_video", "high_res_video", "video")
TEST_MIN, TEST_MAX = 10, 20
HEX32 = re.compile(r"^[0-9a-f]{32}$")
SETUP_HINT = "Run ./setup-khan.sh once (installs Kolibri and fetches the Khan Academy channel), then restart."


class Unavailable(state.Refused):
    pass


# ------------------------------------------------------------------ Kolibri files
def kolibri_bin() -> str | None:
    if KOLIBRI_BIN:
        return KOLIBRI_BIN if Path(KOLIBRI_BIN).exists() else None
    return shutil.which("kolibri")


def channel_db() -> Path:
    return KOLIBRI_HOME / "content" / "databases" / f"{CHANNEL}.sqlite3"


def stored(fid: str, ext: str) -> Path:
    return KOLIBRI_HOME / "content" / "storage" / fid[0] / fid[1] / f"{fid}.{ext}"


_conn: tuple[float, sqlite3.Connection] | None = None
_conn_lock = threading.Lock()


def _cdb() -> sqlite3.Connection:
    """Read-only connection to the channel database; reopened when Kolibri replaces it (channel update)."""
    global _conn
    p = channel_db()
    if not p.exists():
        raise Unavailable("Khan content isn't set up yet. " + SETUP_HINT)
    m = p.stat().st_mtime
    with _conn_lock:
        if _conn is None or _conn[0] != m:
            if _conn is not None:
                _conn[1].close()
            c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, check_same_thread=False)
            c.row_factory = sqlite3.Row
            _conn = (m, c)
            _unit_nodes.clear()
        return _conn[1]


def _q(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    c = _cdb()
    with _conn_lock:
        return c.execute(sql, params).fetchall()


def _q1(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    rows = _q(sql, params)
    return rows[0] if rows else None


def _check_id(x: str) -> str:
    if not HEX32.match(x or ""):
        raise state.Refused("Bad content id.")
    return x


# ------------------------------------------------------------------ where things are in the channel
_unit_nodes: dict[int, str] = {}


def unit_node(idx: int) -> str:
    if idx in _unit_nodes:
        return _unit_nodes[idx]
    u = khan_unit(idx)
    math = _q1("SELECT id FROM content_contentnode WHERE level=1 AND kind='topic' AND title='Math'")
    course = math and _q1("SELECT id FROM content_contentnode WHERE parent_id=? AND title=?", (math["id"], u["course"]))
    unit = course and _q1("SELECT id FROM content_contentnode WHERE parent_id=? AND title=?", (course["id"], u["name"]))
    if not unit:
        raise Unavailable(f"'{u['course']} · {u['name']}' isn't in the Kolibri channel (it may have been renamed).")
    _unit_nodes[idx] = unit["id"]
    return unit["id"]


def unit_of(node_id: str) -> int | None:
    """The curriculum index of the unit a video or exercise belongs to."""
    n = _q1("SELECT lft, rght, tree_id FROM content_contentnode WHERE id=?", (node_id,))
    if not n:
        return None
    for i in range(len(KHAN_UNITS)):
        try:
            u = _q1("SELECT lft, rght, tree_id FROM content_contentnode WHERE id=?", (unit_node(i),))
        except Unavailable:
            continue
        if u and u["tree_id"] == n["tree_id"] and u["lft"] < n["lft"] and n["rght"] < u["rght"]:
            return i
    return None


def _files(ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    out: dict[str, list[sqlite3.Row]] = {}
    for k in range(0, len(ids), 400):
        chunk = ids[k:k + 400]
        for r in _q(f"SELECT contentnode_id, local_file_id, extension, preset, lang_id, file_size, supplementary "
                    f"FROM content_file WHERE contentnode_id IN ({','.join('?' * len(chunk))})", tuple(chunk)):
            out.setdefault(r["contentnode_id"], []).append(r)
    return out


def _main_file(files: list[sqlite3.Row], presets: tuple[str, ...]) -> sqlite3.Row | None:
    for p in presets:
        for f in files:
            if f["preset"] == p:
                return f
    return None


def kolibri_link(node_id: str) -> str:
    return f"{KOLIBRI_URL}/en/learn/#/topics/c/{node_id}"


# ------------------------------------------------------------------ exercise packages
@lru_cache(maxsize=96)
def _package(path: str, mtime: float) -> dict:
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    meta = json.loads(z.read("exercise.json")) if "exercise.json" in names else {}
    order = meta.get("all_assessment_items") or sorted(n[:-5] for n in names if "/" not in n and n.endswith(".json")
                                                       and n != "exercise.json")
    items = {}
    for i in order:
        if f"{i}.json" in names:
            try:
                items[i] = json.loads(z.read(f"{i}.json"))
            except ValueError:
                continue
    sup = [i for i in order if i in items and perseus.supported(items[i])]
    return {"order": [i for i in order if i in items], "items": items, "supported": sup,
            "mastery": meta.get("mastery_model") or {}}


def _exercise_file(ex_id: str) -> sqlite3.Row:
    f = _q1("SELECT local_file_id, extension FROM content_file WHERE contentnode_id=? AND preset='exercise'", (ex_id,))
    if not f:
        raise state.Refused("No such exercise.")
    return f


def package(ex_id: str) -> dict:
    f = _exercise_file(_check_id(ex_id))
    p = stored(f["local_file_id"], f["extension"])
    if not p.exists():
        raise Unavailable("This exercise hasn't been downloaded yet; it's on its way.")
    return _package(str(p), p.stat().st_mtime)


def mastery_model(ex_id: str) -> tuple[int, int]:
    n = _q1("SELECT options FROM content_contentnode WHERE id=?", (ex_id,))
    try:
        th = json.loads(n["options"] or "{}").get("completion_criteria", {}).get("threshold", {})
        return int(th.get("m", 5)), int(th.get("n", 7))
    except (TypeError, ValueError, AttributeError):
        return 5, 7


def zip_file(ex_id: str, name: str) -> tuple[bytes, str]:
    name = re.sub(r"[^A-Za-z0-9._-]", "", name)
    f = _exercise_file(_check_id(ex_id))
    p = stored(f["local_file_id"], f["extension"])
    try:
        data = zipfile.ZipFile(p).read(f"images/{name}")
    except (KeyError, FileNotFoundError):
        raise state.Refused("No such image.") from None
    ext = name.rsplit(".", 1)[-1].lower()
    return data, {"svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                  "gif": "image/gif", "json": "application/json"}.get(ext, "application/octet-stream")


def graphie(ex_id: str, h: str) -> dict:
    data, _ = zip_file(ex_id, f"{re.sub(r'[^0-9a-f]', '', h)}-data.json")
    return perseus.graphie_labels(data)


# ------------------------------------------------------------------ status and downloads
_dl: dict = {"running": None, "queue": [], "errors": {}, "done_at": {}}
_dl_lock = asyncio.Lock()
_up: tuple[float, bool] = (0.0, False)


def server_up() -> bool:
    global _up
    if time.monotonic() - _up[0] < 15:
        return _up[1]
    ok = False
    try:
        import httpx
        ok = httpx.get(KOLIBRI_URL + "/api/public/info/", timeout=0.5).status_code == 200
    except Exception:
        ok = False
    _up = (time.monotonic(), ok)
    return ok


def status() -> dict:
    ch = channel_db()
    return {"installed": bool(kolibri_bin()), "channel": ch.exists(), "home": str(KOLIBRI_HOME),
            "server": server_up(), "server_url": KOLIBRI_URL, "downloading": _dl["running"],
            "queued": list(_dl["queue"]), "errors": dict(_dl["errors"]), "setup": SETUP_HINT}


def unit_files(idx: int) -> tuple[int, int]:
    """(files the unit needs, files already on disk): videos and exercise packages."""
    u = _q1("SELECT lft, rght, tree_id FROM content_contentnode WHERE id=?", (unit_node(idx),))
    rows = _q("SELECT f.local_file_id, f.extension FROM content_contentnode n JOIN content_file f ON f.contentnode_id=n.id "
              "WHERE n.tree_id=? AND n.lft>? AND n.rght<? AND f.preset IN ('exercise','low_res_video','high_res_video','video')",
              (u["tree_id"], u["lft"], u["rght"]))
    have = sum(1 for r in rows if stored(r["local_file_id"], r["extension"]).exists())
    return len(rows), have


def request_download(idx: int) -> bool:
    """Queue a unit for download (Kolibri's importer). Returns False when Kolibri isn't installed."""
    if not kolibri_bin() or not channel_db().exists():
        return False
    if idx == _dl["running"] or idx in _dl["queue"]:
        return True
    from . import bus
    loop = bus._loop
    if loop is None:          # no server running (scripts, tests)
        return False
    _dl["queue"].append(idx)

    def go() -> None:
        from .main import spawn
        spawn(_download_next(), f"khan_download_{idx}")

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        go()
    else:                     # called from a request's worker thread
        loop.call_soon_threadsafe(go)
    return True


async def _download_next() -> None:
    async with _dl_lock:
        if not _dl["queue"]:
            return
        idx = _dl["queue"].pop(0)
        _dl["running"] = idx
        try:
            await download(idx)
        finally:
            _dl["running"] = None


async def download(idx: int) -> None:
    node = unit_node(idx)
    env = {**os.environ, "KOLIBRI_HOME": str(KOLIBRI_HOME)}
    cmd = [kolibri_bin() or "kolibri", "manage", "importcontent", "--node_ids", node, "network", CHANNEL]
    log.info("downloading Khan unit %d (%s)", idx, khan_unit(idx)["name"])
    proc = await asyncio.create_subprocess_exec(*cmd, env=env, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    need, have = unit_files(idx)
    name = khan_unit(idx)["name"]
    if proc.returncode != 0 or have < need:
        tail = (out or b"").decode("utf-8", "replace").strip().splitlines()[-3:]
        msg = f"exit {proc.returncode}, {have}/{need} files" + (": " + " ".join(tail)[-300:] if tail else "")
        _dl["errors"][idx] = msg
        health.warn(f"khan_download_{idx}", f"Khan '{name}' didn't fully download ({msg}). It retries when you open the unit.")
        log.warning("Khan download for unit %d incomplete: %s", idx, msg)
    else:
        _dl["errors"].pop(idx, None)
        _dl["done_at"][idx] = db.ts()
        health.clear(f"khan_download_{idx}")


def prefetch() -> list[int]:
    """The current unit and the next one, so the morning never waits on a download."""
    if not kolibri_bin() or not channel_db().exists():
        return []
    cur = db.kv_get("cursor", {}).get("khan_unit", 0)
    queued = []
    for idx in (cur, cur + 1):
        if idx >= len(KHAN_UNITS):
            continue
        try:
            need, have = unit_files(idx)
        except Unavailable:
            continue
        if have < need and request_download(idx):
            queued.append(idx)
    return queued


# ------------------------------------------------------------------ unit outline
def _progress(ex_id: str) -> dict:
    m, n = mastery_model(ex_id)
    last = [r["correct"] for r in db.q("SELECT correct FROM khan_attempts WHERE exercise_id=? AND mode='practice' "
                                         "ORDER BY id DESC LIMIT ?", (ex_id, n))][::-1]
    mastered = db.q1("SELECT mastered_at FROM khan_mastery WHERE exercise_id=?", (ex_id,))
    return {"m": m, "n": n, "last": last, "mastered": bool(mastered),
            "mastered_at": mastered["mastered_at"] if mastered else None}


def outline(idx: int) -> dict:
    if not 0 <= idx < len(KHAN_UNITS):
        raise state.Refused("No such unit.")
    u = khan_unit(idx)
    root = unit_node(idx)
    n = _q1("SELECT lft, rght, tree_id FROM content_contentnode WHERE id=?", (root,))
    rows = _q("SELECT id, title, kind, duration, parent_id, description FROM content_contentnode "
              "WHERE tree_id=? AND lft>? AND rght<? AND kind IN ('topic','video','exercise') ORDER BY lft",
              (n["tree_id"], n["lft"], n["rght"]))
    files = _files([r["id"] for r in rows if r["kind"] != "topic"])
    lessons: list[dict] = []
    lesson_of: dict[str, dict] = {}
    for r in rows:
        if r["kind"] == "topic":
            if r["parent_id"] == root:
                lesson = {"id": r["id"], "title": r["title"], "items": []}
                lessons.append(lesson)
                lesson_of[r["id"]] = lesson
            elif r["parent_id"] in lesson_of:
                lesson_of[r["id"]] = lesson_of[r["parent_id"]]
            continue
        lesson = lesson_of.get(r["parent_id"])
        if lesson is None:
            continue
        fs = files.get(r["id"], [])
        if r["kind"] == "video":
            f = _main_file(fs, VIDEO_PRESETS)
            lesson["items"].append({"id": r["id"], "kind": "video", "title": r["title"], "duration": r["duration"],
                                    "ready": bool(f) and stored(f["local_file_id"], f["extension"]).exists()})
        else:
            f = _main_file(fs, ("exercise",))
            ready = bool(f) and stored(f["local_file_id"], f["extension"]).exists()
            item = {"id": r["id"], "kind": "exercise", "title": r["title"], "ready": ready,
                    "kolibri": kolibri_link(r["id"]), **_progress(r["id"])}
            if ready:
                pk = package(r["id"])
                item |= {"supported": len(pk["supported"]), "total": len(pk["order"])}
            lesson["items"].append(item)
    items = [i for les in lessons for i in les["items"]]
    vids = [i for i in items if i["kind"] == "video"]
    exs = [i for i in items if i["kind"] == "exercise"]
    need = len(vids) + len(exs)
    have = sum(1 for i in items if i["ready"])
    if have < need and _dl["running"] != idx and idx not in _dl["queue"]:
        request_download(idx)
    return {"unit": {"idx": idx, "name": u["name"], "course": u["course"], "href": u["href"]},
            "lessons": lessons, "status": status(),
            "counts": {"videos": len(vids), "videos_ready": sum(i["ready"] for i in vids), "exercises": len(exs),
                       "exercises_ready": sum(i["ready"] for i in exs), "mastered": sum(i["mastered"] for i in exs),
                       "video_min": round(sum(i["duration"] or 0 for i in vids) / 60)},
            "downloading": _dl["running"] == idx or idx in _dl["queue"], "error": _dl["errors"].get(idx)}


def video(node_id: str) -> dict:
    n = _q1("SELECT id, title, description, duration FROM content_contentnode WHERE id=? AND kind='video'",
            (_check_id(node_id),))
    if not n:
        raise state.Refused("No such video.")
    fs = _files([node_id]).get(node_id, [])
    f = _main_file(fs, VIDEO_PRESETS)
    if not f or not stored(f["local_file_id"], f["extension"]).exists():
        raise Unavailable("This video hasn't been downloaded yet.")
    subs = [{"lang": s["lang_id"], "label": SUBTITLE_LANGS[s["lang_id"]], "src": f"/api/khan/file/{s['local_file_id']}.vtt"}
            for s in fs if s["preset"] == "video_subtitle" and s["lang_id"] in SUBTITLE_LANGS
            and stored(s["local_file_id"], "vtt").exists()]
    thumb = _main_file(fs, ("video_thumbnail",))
    return {"id": n["id"], "title": n["title"], "description": n["description"] or "", "duration": n["duration"],
            "src": f"/api/khan/file/{f['local_file_id']}.{f['extension']}", "subtitles": subs,
            "poster": f"/api/khan/file/{thumb['local_file_id']}.{thumb['extension']}" if thumb and
            stored(thumb["local_file_id"], thumb["extension"]).exists() else None}


def file_path(name: str) -> Path:
    m = re.fullmatch(r"([0-9a-f]{32})\.(mp4|webm|vtt|png|jpg|jpeg)", name or "")
    if not m:
        raise state.Refused("Bad file name.")
    p = stored(m.group(1), m.group(2))
    if not p.exists():
        raise state.Refused("Not downloaded.")
    return p


# ------------------------------------------------------------------ practice
def _base(ex_id: str) -> str:
    return f"/api/khan/img/{ex_id}"


def _public_item(ex_id: str, item_id: str, item: dict) -> dict:
    return perseus.public(item["question"], _base(ex_id), item_id)


def _current() -> dict:
    return db.kv_get("khan_current", {})


def next_item(ex_id: str) -> dict:
    pk = package(ex_id)
    cur = _current()
    c = cur.get(ex_id)
    if not c or c.get("item") not in pk["supported"]:
        if not pk["supported"]:
            raise Unavailable("None of this exercise's questions can be shown in the app; open it in Kolibri.")
        seen = {r["item_id"]: r["n"] for r in db.q(
            "SELECT item_id, COUNT(*) n FROM khan_attempts WHERE exercise_id=? GROUP BY item_id", (ex_id,))}
        last = db.q1("SELECT item_id FROM khan_attempts WHERE exercise_id=? ORDER BY id DESC LIMIT 1", (ex_id,))
        pool = [i for i in pk["supported"] if not last or i != last["item_id"]] or pk["supported"]
        low = min(seen.get(i, 0) for i in pool)
        c = {"item": random.choice([i for i in pool if seen.get(i, 0) == low]), "hints": 0, "counted": False}
        cur[ex_id] = c
        db.kv_set("khan_current", cur)
    item = pk["items"][c["item"]]
    return {"exercise_id": ex_id, "item_id": c["item"], "question": _public_item(ex_id, c["item"], item),
            "hints_total": len(perseus.hints(item)), "hints": [perseus.public(h, _base(ex_id), c["item"])
                                                               for h in perseus.hints(item)[:c["hints"]]],
            "counted": c["counted"], "progress": _progress(ex_id), "title": _title(ex_id)}


def _title(node_id: str) -> str:
    r = _q1("SELECT title FROM content_contentnode WHERE id=?", (node_id,))
    return r["title"] if r else ""


def _record(ex_id: str, item_id: str, correct: bool, hinted: bool, answer, mode: str = "practice",
            test_id: int | None = None) -> None:
    db.ex("INSERT INTO khan_attempts(ts,date,exercise_id,item_id,mode,test_id,correct,hinted,answer) VALUES(?,?,?,?,?,?,?,?,?)",
          (db.ts(), today().isoformat(), ex_id, item_id, mode, test_id, int(correct), int(hinted), json.dumps(answer)[:2000]))
    if mode != "practice":
        return
    p = _progress(ex_id)
    if not p["mastered"] and len(p["last"]) >= min(p["m"], p["n"]) and sum(p["last"]) >= p["m"]:
        db.ex("INSERT OR IGNORE INTO khan_mastery(exercise_id, unit_idx, mastered_at) VALUES(?,?,?)",
              (ex_id, unit_of(ex_id), db.ts()))
        state.log_event("khan_mastered", None, {"exercise": _title(ex_id)})


def _same_item(ex_id: str, item_id: str) -> dict:
    c = _current().get(ex_id)
    if not c or c.get("item") != item_id:
        raise state.Refused("That question is no longer the current one; reload the exercise.")
    return c


def hint(ex_id: str, item_id: str) -> dict:
    c = _same_item(ex_id, item_id)
    item = package(ex_id)["items"][item_id]
    hs = perseus.hints(item)
    if c["hints"] < len(hs):
        c["hints"] += 1
        cur = _current()
        cur[ex_id] = c
        db.kv_set("khan_current", cur)
    return {"hints": [perseus.public(h, _base(ex_id), item_id) for h in hs[:c["hints"]]], "hints_total": len(hs)}


def check(ex_id: str, item_id: str, answers: dict) -> dict:
    """Like Khan: the first check of a question counts (a hint first makes it count as wrong); after a
    wrong answer you can keep trying, and a right answer moves on to the next question."""
    c = _same_item(ex_id, item_id)
    item = package(ex_id)["items"][item_id]
    g = perseus.grade(item, answers or {})
    with db.tx():
        if not c["counted"]:
            _record(ex_id, item_id, g["correct"] and c["hints"] == 0, c["hints"] > 0, answers)
            c["counted"] = True
        cur = _current()
        if g["correct"]:
            cur.pop(ex_id, None)
        else:
            cur[ex_id] = c
        db.kv_set("khan_current", cur)
    return {**g, "progress": _progress(ex_id), "solution": perseus.solution(item) if g["correct"] else None}


def reveal(ex_id: str, item_id: str) -> dict:
    """Give up on this question: it counts as wrong, the worked solution (all hints) is shown."""
    c = _same_item(ex_id, item_id)
    item = package(ex_id)["items"][item_id]
    with db.tx():
        if not c["counted"]:
            _record(ex_id, item_id, False, True, None)
        cur = _current()
        cur.pop(ex_id, None)
        db.kv_set("khan_current", cur)
    return {"hints": [perseus.public(h, _base(ex_id), item_id) for h in perseus.hints(item)],
            "solution": perseus.solution(item), "progress": _progress(ex_id)}


# ------------------------------------------------------------------ unit test
def _unit_exercises(idx: int) -> list[str]:
    n = _q1("SELECT lft, rght, tree_id FROM content_contentnode WHERE id=?", (unit_node(idx),))
    return [r["id"] for r in _q("SELECT id FROM content_contentnode WHERE tree_id=? AND lft>? AND rght<? "
                                "AND kind='exercise' ORDER BY lft", (n["tree_id"], n["lft"], n["rght"]))]


def build_test_items(idx: int, rnd: random.Random | None = None) -> list[dict]:
    rnd = rnd or random.Random()
    exs = _unit_exercises(idx)
    pools: list[tuple[str, list[str]]] = []
    missing = 0
    for ex in exs:
        try:
            pk = package(ex)
        except Unavailable:
            missing += 1
            continue
        if pk["supported"]:
            practiced = {r["item_id"] for r in db.q("SELECT DISTINCT item_id FROM khan_attempts WHERE exercise_id=?", (ex,))}
            fresh = [i for i in pk["supported"] if i not in practiced]
            rest = [i for i in pk["supported"] if i in practiced]
            rnd.shuffle(fresh)
            rnd.shuffle(rest)
            pools.append((ex, fresh + rest))
    if missing:
        raise Unavailable(f"{missing} of the unit's exercises are still downloading; the test needs all of them.")
    want = max(TEST_MIN, min(TEST_MAX, len(pools)))
    out: list[dict] = []
    rnd.shuffle(pools)
    k = 0
    while len(out) < want and any(k < len(p) for _, p in pools):
        for ex, p in pools:
            if k < len(p) and len(out) < want:
                out.append({"exercise_id": ex, "item_id": p[k]})
        k += 1
    if len(out) < 5:
        raise Unavailable("Not enough questions the app can show for this unit; take the unit test on Khan and enter the score.")
    # keep the unit's order: easier lessons first, like Khan's tests
    order = {ex: i for i, ex in enumerate(exs)}
    out.sort(key=lambda x: order[x["exercise_id"]])
    return out


def start_test(task_id: int) -> int:
    t = db.decode(state.get_task(task_id))
    state.require_active(t["date"])
    if t["kind"] != "khan_test" and t["meta"].get("score_kind") != "khan_unit":
        raise state.Refused("Only a unit-test task has a unit test.")
    idx = int(t["meta"].get("unit_idx", 0))
    open_ = db.q1("SELECT id FROM khan_tests WHERE task_id=? AND status='in_progress' ORDER BY id DESC LIMIT 1", (task_id,))
    if open_:
        return open_["id"]
    items = build_test_items(idx)
    return db.ex("INSERT INTO khan_tests(date,task_id,unit_idx,status,items,created_at) VALUES(?,?,?,?,?,?)",
                 (t["date"], task_id, idx, "in_progress", json.dumps(items), db.ts()))


def _key(it: dict) -> str:
    return f"{it['exercise_id']}:{it['item_id']}"


def get_test(tid: int) -> dict:
    t = db.q1("SELECT * FROM khan_tests WHERE id=?", (tid,))
    if not t:
        raise state.Refused("No such test.")
    items = json.loads(t["items"])
    results = json.loads(t["results"]) if t["results"] else None
    qs = []
    for it in items:
        k = _key(it)
        try:
            item = package(it["exercise_id"])["items"][it["item_id"]]
        except (Unavailable, KeyError):
            qs.append({"key": k, "exercise": _title(it["exercise_id"]), "missing": True})
            continue
        q = {"key": k, "exercise": _title(it["exercise_id"]), "question": _public_item(it["exercise_id"], it["item_id"], item)}
        if results:
            q["hints"] = [perseus.public(h, _base(it["exercise_id"]), it["item_id"]) for h in perseus.hints(item)]
        qs.append(q)
    u = khan_unit(t["unit_idx"])
    return {"id": t["id"], "date": t["date"], "task_id": t["task_id"], "status": t["status"], "score": t["score"],
            "unit": {"idx": t["unit_idx"], "name": u["name"], "course": u["course"]}, "questions": qs,
            "answers": json.loads(t["answers"] or "{}"), "results": results, "threshold": 90}


def save_test_answers(tid: int, answers: dict) -> None:
    t = db.q1("SELECT status FROM khan_tests WHERE id=?", (tid,))
    if not t or t["status"] != "in_progress":
        raise state.Refused("This test is already submitted.")
    db.ex("UPDATE khan_tests SET answers=? WHERE id=?", (json.dumps(answers or {})[:200_000], tid))


def submit_test(tid: int, answers: dict) -> dict:
    t = db.q1("SELECT * FROM khan_tests WHERE id=?", (tid,))
    if not t or t["status"] != "in_progress":
        raise state.Refused("This test is already submitted.")
    task = db.decode(state.get_task(t["task_id"]))
    state.require_active(task["date"])
    items = json.loads(t["items"])
    results, right = {}, 0
    with db.tx():
        for it in items:
            k = _key(it)
            item = package(it["exercise_id"])["items"][it["item_id"]]
            a = (answers or {}).get(k) or {}
            g = perseus.grade(item, a)
            right += g["correct"]
            results[k] = {**g, "solution": perseus.solution(item)}
            _record(it["exercise_id"], it["item_id"], g["correct"], False, a, mode="test", test_id=tid)
        score = round(100 * right / len(items), 1)
        db.ex("UPDATE khan_tests SET status='submitted', answers=?, results=?, score=?, submitted_at=? WHERE id=?",
              (json.dumps(answers or {}), json.dumps(results), score, db.ts(), tid))
    r = state.record_khan_score(t["task_id"], score)
    _note_change_once()
    prefetch()
    return {"test": get_test(tid), "passed": r["passed"], "message": f"{right}/{len(items)} = {score:g}%. " + r["message"]}


def _note_change_once() -> None:
    """The unit-test gate moved into the app (the user asked for it on 2026-11-22): say so once in COACH.md."""
    if db.kv_get("khan_inapp_logged"):
        return
    from . import planner
    if planner.append_coach_log("Plan: Khan ünite testi artık uygulamanın içinde, Khan'ın kendi soruları ile (Kolibri "
                                "üzerinden) yapılıyor ve otomatik puanlanıyor; eşik aynı (≥ %90). Kullanıcı onayı: 2026-11-22."):
        db.kv_set("khan_inapp_logged", db.ts())


def summary(ds: str) -> dict:
    """For PROGRESS.md and the coach: what happened in Khan exercises on a day."""
    att = db.q("SELECT exercise_id, correct FROM khan_attempts WHERE date=? AND mode='practice'", (ds,))
    mastered = db.q("SELECT exercise_id FROM khan_mastery WHERE substr(mastered_at,1,10)=?", (ds,))
    names = []
    for m in mastered:
        try:
            names.append(_title(m["exercise_id"]))
        except Unavailable:
            names.append(m["exercise_id"][:8])
    return {"questions": len(att), "right": sum(a["correct"] for a in att), "mastered": names}


# ------------------------------------------------------------------ coach brief
def _plain(md: str, limit: int = 260) -> str:
    """Question text for the coach: widget placeholders and pictures out, one line, short."""
    s = re.sub(r"\[\[☃ [a-z-]+ \d+\]\]", " ___ ", md or "")
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[picture]", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[:limit].rstrip() + "…"


def _given(item: dict, answers: dict) -> str:
    """What the user entered, widget by widget, in words (a picked choice as its text, not its index)."""
    out = []
    for name, w in perseus.widgets_used(item["question"]).items():
        t, o = w.get("type"), w.get("options") or {}
        if t not in perseus.GRADED or w.get("graded") is False:
            continue
        a = answers.get(name)
        if t in ("radio", "dropdown"):
            ch = o.get("choices") or []
            idx = a if isinstance(a, list) else ([] if a in (None, "") else [a])
            picked = [ch[int(i)].get("content", "") or "None of the above" for i in idx
                      if str(i).lstrip("-").isdigit() and 0 <= int(i) < len(ch)]
            out.append(" · ".join(picked) or "(blank)")
        else:
            out.append(str(a).strip() if a not in (None, "") else "(blank)")
    return "; ".join(out)


def coach_brief(days: int = 21) -> str:
    """The latest Khan unit test of each unit (last `days` days) for the coach: score, every missed question with
    the user's answer and the right one, and what practice the user did on those exercises since."""
    since = (today() - timedelta(days=days)).isoformat()
    rows = db.q("SELECT * FROM khan_tests WHERE status='submitted' AND date>=? ORDER BY id DESC", (since,))
    seen, lines = set(), []
    for t in rows:
        if t["unit_idx"] in seen:
            continue
        seen.add(t["unit_idx"])
        items, results = json.loads(t["items"]), json.loads(t["results"] or "{}")
        answers = json.loads(t["answers"] or "{}")
        try:
            name = khan_unit(t["unit_idx"])["name"]
        except Exception:  # noqa: BLE001
            name = f"unit {t['unit_idx']}"
        missed = [it for it in items if not (results.get(_key(it)) or {}).get("correct")]
        ok = (t["score"] or 0) >= 90
        lines.append(f"Unit test #{t['id']} \"{name}\" on {t['date']}: {t['score']:g}% (pass mark 90%, "
                     f"{'passed' if ok else 'NOT passed, retake needed'}); {len(items) - len(missed)}/{len(items)} right. "
                     f"Review page with every question and worked solution: #/khan-test/{t['id']}")
        by_ex: dict[str, list[dict]] = {}
        for it in missed:
            by_ex.setdefault(it["exercise_id"], []).append(it)
        for ex, its in by_ex.items():
            title = _title(ex)
            after = db.q("SELECT correct FROM khan_attempts WHERE exercise_id=? AND mode='practice' AND ts>?",
                         (ex, t["submitted_at"] or t["created_at"]))
            prog = _progress(ex)
            practice = (f"practice since the test: {sum(a['correct'] for a in after)}/{len(after)} right"
                        if after else "no practice since the test")
            lines.append(f"  Missed in \"{title}\" ({practice}{'; mastered' if prog['mastered'] else ''}):")
            for it in its:
                k = _key(it)
                try:
                    item = package(ex)["items"][it["item_id"]]
                except (Unavailable, KeyError):
                    continue
                right = "; ".join(v for v in (results.get(k) or {}).get("solution", {}).values() if v)
                lines.append(f"    - Q: {_plain(item['question'].get('content', ''))} | user answered: "
                             f"{_given(item, answers.get(k) or {})} | right answer: {right}")
    if not lines:
        return ""
    return ("[KHAN UNIT TESTS] The user's latest Khan unit tests (already submitted; the user has seen the answers and "
            "worked solutions on the review page). Use them to steer the user: name the exact weak exercises, go through "
            "a missed question with them (ask them to redo it and say where they went wrong before you explain the step), "
            "and send them to practise those exercises in the day's lessons + exercises task before a retake.\n"
            + "\n".join(lines))

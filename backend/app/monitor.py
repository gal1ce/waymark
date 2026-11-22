"""Watches the study repo, compiles C files on save, polls git, and turns
silence / repeated failures / overtime into stuck-points."""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from watchfiles import Change, awatch

from . import bus, db, files, health, state
from .config import (COMPILE_FAIL_STREAK, IDLE_STUCK_MIN, OVERTIME_FACTOR, STUDY_REPO, now, today)
from .curriculum import C_COMPILE

log = logging.getLogger("ctu.monitor")

IGNORE_PARTS = {".git", "build", "node_modules", "__pycache__"}

# What the repo watcher is doing, shown in /api/meta and the health panel.
WATCH: dict = {"state": "starting", "since": None, "detail": ""}
CHECK_EVERY_SEC = 5


def _rel(p: str) -> str | None:
    try:
        rel = Path(p).resolve().relative_to(STUDY_REPO.resolve())
    except ValueError:
        return None
    if any(part in IGNORE_PARTS for part in rel.parts):
        return None
    return rel.as_posix()


def _task_for_file(rel: str) -> int | None:
    ds = today().isoformat()
    for t in db.q("SELECT id, files FROM tasks WHERE date=?", (ds,)):
        if rel in json.loads(t["files"]):
            return t["id"]
    cur = db.q1("SELECT id FROM tasks WHERE status='doing' LIMIT 1")
    return cur["id"] if cur else None


async def compile_c(rel: str, task_id: int | None) -> dict:
    src = STUDY_REPO / rel
    with tempfile.TemporaryDirectory() as td:
        proc = await asyncio.create_subprocess_exec(
            *C_COMPILE, str(src), "-o", str(Path(td) / "a.out"), "-lm",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(src.parent))
        _, err = await proc.communicate()
    stderr = err.decode(errors="replace").replace(str(STUDY_REPO) + "/", "")
    ok = proc.returncode == 0
    state.log_event("compile_ok" if ok else "compile_fail", task_id, {"file": rel, "stderr": stderr[-4000:]})
    if not ok:
        _check_compile_streak(rel, task_id, stderr)
    return {"ok": ok, "stderr": stderr}


def _first_error(stderr: str) -> str:
    for line in stderr.splitlines():
        if "error" in line:
            return line.strip()[:200]
    return stderr.strip().splitlines()[0][:200] if stderr.strip() else ""


def _check_compile_streak(rel: str, task_id: int | None, stderr: str) -> None:
    since = (now() - timedelta(minutes=25)).isoformat(timespec="seconds")
    rows = db.q("SELECT type, data FROM events WHERE type IN ('compile_ok','compile_fail') AND ts>=? "
                "ORDER BY id DESC LIMIT 10", (since,))
    rows = [r for r in rows if json.loads(r["data"]).get("file") == rel]
    streak = 0
    for r in rows:
        if r["type"] != "compile_fail":
            break
        streak += 1
    if streak >= COMPILE_FAIL_STREAK:
        state.add_stuck("compile", f"{rel}: {streak} failed compiles in a row", task_id,
                        _first_error(stderr))


def _watch_state(st: str, detail: str = "") -> None:
    if WATCH["state"] != st or WATCH["detail"] != detail:
        WATCH.update(state=st, since=db.ts(), detail=detail)
        bus.publish("watcher", dict(WATCH))
        if st in ("watching", "unused"):
            health.clear("watcher")
        elif st in ("waiting", "error"):
            health.warn("watcher", f"The repo watcher is not running ({detail}). Saved .c files are not compiled; "
                                   "use 'Compile now' on the task.")


async def _handle(changes) -> None:
    for change, path in changes:
        try:
            rel = _rel(path)
            if not rel or change == Change.deleted or files.is_own_write(path):
                continue
            task_id = _task_for_file(rel)
            state.log_event("file_change", task_id, {"file": rel})
            if rel.endswith(".c"):
                await compile_c(rel, task_id)
        except Exception:  # noqa: BLE001 - one bad event must not stop the watcher
            log.exception("handling change to %s", path)


async def watch_repo() -> None:
    """Watch the study repo for as long as the app runs. Waits for the folder if it is missing, and starts
    over when the folder is deleted, replaced or the watch dies, instead of going quiet."""
    while True:
        try:
            if not STUDY_REPO.is_dir():
                # a plan without a study repo (most custom plans) has nothing to watch: that is not a problem
                from . import profile
                if profile.is_ctu() or profile.has("repo"):
                    _watch_state("waiting", f"{STUDY_REPO} does not exist")
                else:
                    _watch_state("unused", "this plan has no study repo")
                await asyncio.sleep(CHECK_EVERY_SEC)
                continue
            ino = STUDY_REPO.stat().st_ino
            stop = asyncio.Event()

            async def guard() -> None:
                while not stop.is_set():
                    await asyncio.sleep(CHECK_EVERY_SEC)
                    try:
                        if STUDY_REPO.stat().st_ino != ino:
                            break
                    except OSError:
                        break
                stop.set()

            g = asyncio.create_task(guard())
            _watch_state("watching", str(STUDY_REPO))
            try:
                async for changes in awatch(STUDY_REPO, recursive=True, step=300, stop_event=stop):
                    await _handle(changes)
            finally:
                stop.set()
                g.cancel()
            log.info("repo folder changed or watch ended; restarting the watcher")
            _watch_state("restarting", "the repo folder was replaced")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - report, wait, try again
            log.exception("repo watcher failed")
            _watch_state("error", f"{type(e).__name__}: {e}"[:200])
            await asyncio.sleep(CHECK_EVERY_SEC * 2)


async def compile_task(task_id: int) -> list[dict]:
    """Compile a task's .c files on demand (the 'Compile now' button), whether or not the watcher saw the save."""
    t = db.decode(state.get_task(task_id))
    out = []
    for f in t["files"]:
        if f.endswith(".c") and (STUDY_REPO / f).is_file():
            r = await compile_c(f, task_id)
            out.append({"file": f, **r})
    if not out:
        raise state.Refused("No .c file of this task exists in the repo yet.")
    return out


async def _git_head() -> str | None:
    proc = await asyncio.create_subprocess_exec("git", "-C", str(STUDY_REPO), "rev-parse", "HEAD",
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    out, _ = await proc.communicate()
    return out.decode().strip() or None


async def tick_loop(close_day_cb) -> None:
    from . import planner, tests_eod
    head = await _git_head()
    while True:
        await asyncio.sleep(60)
        try:
            h = await _git_head()
            if h and h != head:
                proc = await asyncio.create_subprocess_exec(
                    "git", "-C", str(STUDY_REPO), "log", "-1", "--pretty=%s", stdout=asyncio.subprocess.PIPE)
                msg, _ = await proc.communicate()
                state.log_event("commit", None, {"hash": h[:8], "message": msg.decode().strip()})
                head = h
            for tid in state.pause_away():
                bus.publish("paused_away", {"task_id": tid})
            _idle_and_overtime()
            await tests_eod.expire_overdue()
            # Close any study day left open after midnight.
            for d in db.q("SELECT date FROM days WHERE status='planned' AND date<?", (today().isoformat(),)):
                await close_day_cb(d["date"], auto=True)
            await planner.resume_closes()
            bus.publish("tick", {"now": now().isoformat(timespec="seconds")})
        except Exception:  # noqa: BLE001 - keep the monitor alive
            log.exception("monitor tick error")


def _idle_and_overtime() -> None:
    t = db.q1("SELECT * FROM tasks WHERE status='doing' LIMIT 1")
    if not t:
        return
    t = db.decode(t)
    spent_min = state.minutes_on_task(t["id"])
    if spent_min > t["est_min"] * OVERTIME_FACTOR and spent_min >= 20:
        state.add_stuck("overtime", f"'{t['title']}' is far over its estimate ({spent_min} min / {t['est_min']} min)",
                        t["id"], dedupe_min=60)
    # Silence only means something where we can see the work: repo files or the in-app reader.
    observable = t["files"] or t["kind"] in ("kintsugi_read",)
    if not observable:
        return
    last = db.q1("SELECT MAX(ts) ts FROM events WHERE task_id=? AND type IN "
                 "('file_change','compile_ok','compile_fail','start','reader_activity')", (t["id"],))["ts"]
    site = db.kv_get("last_site_input")
    times = [x for x in (last, t["started_at"], site) if x]
    if not times:
        return
    idle = (now() - datetime.fromisoformat(max(times))).total_seconds() / 60
    if idle >= IDLE_STUCK_MIN:
        state.add_stuck("idle", f"No activity on '{t['title']}' for {int(idle)} minutes", t["id"],
                        "No file changes, no compiles and no interaction with the app.", dedupe_min=45)

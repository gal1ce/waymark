"""HTTP API + SSE stream. Run: uv run uvicorn app.main:app --port 8723"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import (account, agent, backup, bus, codecheck, coach, config, db, health, insights, keys, khan, lessons, monitor, notes, notices,
               onboarding, planlog, planner, practice, profile, seed, state, tests_eod, tracks, xp)
from .config import (APP_ROOT, COACH_MD, DATA_DIR, DB_PATH, FAKE_CLOCK, KINTSUGI, MODEL, STUDY_REPO, has_api_key,
                     now, today)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ctu.main")

_bg: set[asyncio.Task] = set()


def _done(t: asyncio.Task) -> None:
    _bg.discard(t)
    if not t.cancelled() and t.exception():
        log.error("background task %s failed", t.get_name(), exc_info=t.exception())
        health.warn(f"bg_{t.get_name()}", f"Background job '{t.get_name()}' failed: {t.exception()!r}"[:300])


def spawn(coro, name: str | None = None) -> None:
    t = asyncio.create_task(coro, name=name or getattr(coro, "__name__", "task"))
    _bg.add(t)
    t.add_done_callback(_done)


def _startup_backup() -> None:
    last = db.kv_get("last_backup")
    if not last or last["ts"][:10] < today().isoformat():
        try:
            db.backup(f"{today().isoformat()}-start")
        except Exception:  # noqa: BLE001
            log.exception("startup backup failed")
            health.warn("backup", "The startup backup of the database failed; see the server log.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.allow_default_db()
    keys.load()
    bus.bind_loop(asyncio.get_running_loop())
    seed.seed_if_empty()
    backup.cleanup()
    # Before anything is served: a stopped server leaves timers running and tests half-written, and a day
    # left open overnight is closed here, so the morning auto-close can't race the user's first task.
    state.pause_all("server start")
    n = tests_eod.fail_interrupted()
    if n:
        log.info("%d test generation(s) interrupted by the last shutdown marked failed", n)
    closed = planner.close_overdue_now()
    for ds in closed:
        await planner._run_steps(ds, only_fast=True)
    _startup_backup()
    spawn(monitor.watch_repo(), "watcher")
    spawn(monitor.tick_loop(planner.close_day), "tick")
    spawn(planner.resume_closes(force=True), "resume_closes")
    spawn(planner.ensure_horizon(), "horizon")
    if profile.has("khan"):
        khan.prefetch()
    planlog.write()
    yield
    for t in list(_bg):
        t.cancel()
    await asyncio.gather(*_bg, return_exceptions=True)
    db.checkpoint()


app = FastAPI(lifespan=lifespan)

# ------------------------------------------------------------------ request guard
# The API binds to 127.0.0.1, but any web page in the browser can still send requests to it. Only requests
# addressed to this machine by name (no DNS rebinding) and coming from the app's own pages get through.
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
DEV_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}   # vite dev server proxy
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _hostname(host: str) -> str:
    return host.split("]")[0] + "]" if host.startswith("[") else host.rsplit(":", 1)[0]


@app.middleware("http")
async def guard(request: Request, call_next):
    host = request.headers.get("host", "")
    if _hostname(host) not in LOCAL_HOSTS:
        return JSONResponse({"error": "Unknown host."}, status_code=421)
    origin = request.headers.get("origin")
    if origin is not None and origin not in {f"http://{host}"} | DEV_ORIGINS:
        return JSONResponse({"error": "Cross-site request refused."}, status_code=403)
    if request.method not in SAFE_METHODS:
        site = request.headers.get("sec-fetch-site")
        if site not in (None, "same-origin", "none") and origin not in DEV_ORIGINS:
            return JSONResponse({"error": "Cross-site request refused."}, status_code=403)
        # a custom header can't be sent by a plain form or a no-cors fetch from another site
        if request.url.path.startswith("/api/") and request.headers.get("x-ctu") != "1":
            return JSONResponse({"error": "Missing X-CTU header."}, status_code=403)
    return await call_next(request)


@app.exception_handler(state.Refused)
async def refused(_: Request, e: state.Refused):
    return JSONResponse({"error": str(e)}, status_code=409)


# ------------------------------------------------------------------ read
@app.get("/api/meta")
def meta():
    return {"has_api_key": has_api_key(), "model": MODEL, "repo": str(STUDY_REPO), "start_date": config.start_date().isoformat(),
            "coach_name": coach.settings()["name"], "coach_avatar": _avatar_url(), "today": today().isoformat(), "now": now().isoformat(timespec="seconds"),
            "thresholds": profile.thresholds(), "warnings": health.warnings(), "fake_clock": FAKE_CLOCK,
            "plan": {"key": profile.key(), "ready": profile.ready(), "label": profile.active().get("label", ""),
                     "modules": profile.modules()}, "key_source": keys.info()["source"]}


def _avatar_url() -> str | None:
    name = coach.avatar()
    return f"/api/coach/avatar/{name}" if name else None


def _paths() -> dict:
    """The folders and files the active plan uses (a custom plan has no COACH.md, Kintsugi or Khan content)."""
    out = {}
    if profile.is_ctu() or profile.has("repo") or STUDY_REPO.is_dir():
        out["study repo"] = {"path": str(STUDY_REPO), "ok": STUDY_REPO.is_dir()}
    if profile.is_ctu():
        out["COACH.md"] = {"path": str(COACH_MD), "ok": COACH_MD.is_file()}
        out["Kintsugi"] = {"path": str(KINTSUGI), "ok": KINTSUGI.is_dir()}
    out["data folder"] = {"path": str(DATA_DIR), "ok": DATA_DIR.is_dir()}
    out["database"] = {"path": str(DB_PATH), "ok": DB_PATH.is_file()}
    if profile.key() == "custom":
        out["PLAN.md"] = {"path": str(planlog.path()), "ok": planlog.path().is_file()}
    if profile.has("khan"):
        out["Kolibri (Khan content)"] = {"path": str(khan.KOLIBRI_HOME), "ok": khan.channel_db().exists()}
    return out


@app.get("/api/health")
def health_view():
    """Everything that can silently go wrong, in one place (the Health panel on the Profile page)."""
    last = db.kv_get("last_backup")
    writes = db.q("SELECT ts, data FROM events WHERE type='external_write' ORDER BY id DESC LIMIT 15")
    return {
        "api_key": has_api_key(), "fake_clock": FAKE_CLOCK, "now": now().isoformat(timespec="seconds"),
        "paths": _paths(),
        "watcher": monitor.WATCH, "sandbox": codecheck.SANDBOX,
        "last_backup": last, "backups": len(list(db.backup_dir().glob("ctu-*.db"))) if db.backup_dir().exists() else 0,
        "close_jobs": planner.close_jobs(), "runway": planner.check_runway(), "phases": planner.phases(),
        "schema_version": db.schema_version(), "warnings": health.warnings(),
        "external_writes": [{"ts": w["ts"], **json.loads(w["data"])} for w in writes],
    }


@app.post("/api/health/retry")
async def health_retry():
    """Run unfinished close steps now instead of waiting for the next retry."""
    await planner.resume_closes(force=True)
    return health_view()


@app.get("/api/phases")
def phases_list():
    """Next phases of the curriculum; each changes the plan only after the user approves it."""
    return {"phases": planner.phases(), "runway": planner.check_runway()}


@app.post("/api/phases/{key}/approve")
def phase_approve(key: str):
    return {"phases": planner.set_phase(key, True), "runway": planner.check_runway()}


@app.delete("/api/phases/{key}/approve")
def phase_withdraw(key: str):
    return {"phases": planner.set_phase(key, False), "runway": planner.check_runway()}


@app.delete("/api/health/warnings/{key}")
def warning_dismiss(key: str):
    health.clear(key)
    return {"warnings": health.warnings()}


@app.get("/api/overview")
def overview():
    return state.overview()


@app.get("/api/day/{ds}")
def day(ds: str):
    return state.get_day(ds)


@app.get("/api/today")
def today_view():
    return state.get_day(today().isoformat()) | {"now": now().isoformat(timespec="seconds"),
                                                 "current": state.current_task()}


# ------------------------------------------------------------------ tasks
class Score(BaseModel):
    percent: float


@app.post("/api/tasks/{tid}/score")
def task_score(tid: int, body: Score):
    return state.record_khan_score(tid, body.percent)


@app.post("/api/tasks/{tid}/compile")
async def task_compile(tid: int):
    t = state.get_task(tid)
    state.require_active(t["date"])
    return {"results": await monitor.compile_task(tid)}


@app.post("/api/tasks/{tid}/practice")
async def task_practice(tid: int):
    """A problem task's practice set: original problems of the kind the task asks for, on the Tests page. One open set per
    task: asking again while one is unfinished returns it."""
    task = db.decode(state.get_task(tid))
    if task["kind"] != "practice":
        raise state.Refused("Practice sets belong to problem tasks.")
    if task["date"] > today().isoformat():
        raise state.Refused("That day hasn't started yet.")
    open_ = db.q1("SELECT id FROM tests WHERE kind='practice' AND task_id=? AND cancelled=0 "
                  "AND status IN ('generating','ready','in_progress') ORDER BY id DESC LIMIT 1", (tid,))
    if open_:
        return {"id": open_["id"], "existing": True}
    meta = task.get("meta") or {}
    tr = profile.track(meta.get("track", "")) if meta.get("track") else None
    units = (tr or {}).get("units") or []
    unit = units[meta["unit"]] if isinstance(meta.get("unit"), int) and meta["unit"] < len(units) else None
    topic = unit["title"] if unit else re.sub(r"\s*·\s*problems.*$", "", task["title"]).strip() or task["title"]
    ask = (task.get("detail") or "").split("\n\nWrite full solutions")[0].strip()
    text = "\n".join(x for x in (f"Task: {task['title']}", f"Course: {tr['label']}" if tr else "",
                                 f"Unit objective: {unit.get('objective', '')}" if unit else "", f"It asks for: {ask}" if ask else "") if x)
    spec = practice.resolve(practice.Intent(topics=practice.topics_in(topic), label=topic, count=6), None) | {"task": text}
    test_id = tests_eod.create_practice(spec, tid)
    spawn(tests_eod.fill(test_id))
    return {"id": test_id, "existing": False}


@app.post("/api/tasks/{tid}/lesson")
async def task_lesson(tid: int):
    """A short in-app lesson for a study task of a custom plan: the idea, a worked example of a different problem,
    common mistakes and where to read on. Written once, kept on the task."""
    task = db.decode(state.get_task(tid))
    meta = task.get("meta") or {}
    if meta.get("lesson"):
        return {"lesson": meta["lesson"]}
    tr = profile.track(meta.get("track") or "")
    if task["kind"] != "read" or not tr:
        raise state.Refused("Lessons belong to study tasks of your plan.")
    if task["date"] > today().isoformat():
        raise state.Refused("That day hasn't started yet.")
    text = await lessons.write(task, tr)
    meta["lesson"] = text
    db.ex("UPDATE tasks SET meta=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), tid))
    state.log_event("lesson_written", tid, {})
    return {"lesson": text}


@app.post("/api/tasks/{tid}/explain-now")
def task_explain_now(tid: int):
    """The user asks for concept explanations before the task's first 30 minutes are up. They open for this task
    (never the solution or the code), and the coach is told it was the user's choice and when."""
    task = db.decode(state.get_task(tid))
    state.require_active(task["date"])
    meta = task.get("meta") or {}
    if not meta.get("explain_early"):
        mins = state.minutes_on_task(tid)
        meta["explain_early"] = max(0, mins)
        db.ex("UPDATE tasks SET meta=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), tid))
        state.log_event("explain_now", tid, {"minutes": mins})
        bus.publish("task", {"id": tid})
    return {"ok": True, "explain_early": meta["explain_early"]}


@app.post("/api/tasks/{tid}/{action}")
def task_action(tid: int, action: str):
    if action == "start":
        state.start_task(tid)
    elif action == "pause":
        state.pause_task(tid)
    elif action == "done":
        return state.complete_task(tid)
    elif action == "reopen":
        state.reopen_task(tid)
    else:
        raise HTTPException(404)
    return {"ok": True}


class StuckIn(BaseModel):
    summary: str
    task_id: int | None = None


@app.post("/api/stuck")
def stuck_add(body: StuckIn):
    tid = body.task_id or (state.current_task() or {}).get("id")
    sid = state.add_stuck("manual", body.summary.strip()[:300], tid, dedupe_min=0)
    return {"id": sid}


@app.post("/api/stuck/{sid}/resolve")
def stuck_resolve(sid: int):
    state.resolve_stuck(sid)
    return {"ok": True}


class Heartbeat(BaseModel):
    input: bool = False
    view: str = ""
    kintsugi_file: str = ""


@app.post("/api/heartbeat")
def heartbeat(body: Heartbeat):
    db.kv_set("last_seen", db.ts())   # the app is open: running timers keep counting
    if body.input:
        db.kv_set("last_site_input", db.ts())
        if body.kintsugi_file:
            cur = state.current_task()
            if cur and cur["kind"] == "kintsugi_read":
                state.log_event("reader_activity", cur["id"], {"file": body.kintsugi_file})
    return {"ok": True}


# ------------------------------------------------------------------ day
class CloseIn(BaseModel):
    confirm: bool = False


def close_checklist(ds: str) -> list[dict]:
    """What is still open before closing; the UI shows it, and closing with open items needs confirm=true."""
    test = db.q1("SELECT status FROM tests WHERE date=? AND kind='eod' ORDER BY id DESC LIMIT 1", (ds,))
    running = db.q1("SELECT title FROM tasks WHERE date=? AND status='doing' LIMIT 1", (ds,))
    day = db.q1("SELECT summary FROM days WHERE date=?", (ds,))
    return [
        {"key": "test", "ok": bool(test and test["status"] == "submitted"),
         "label": "End-of-day test submitted" if test and test["status"] == "submitted"
         else f"End-of-day test is {'not started' if not test else test['status'].replace('_', ' ')}"},
        {"key": "timer", "ok": not running, "label": "No timer running" if not running
         else f"'{running['title']}' is still running (it will be stopped)"},
        {"key": "notes", "ok": bool(day and day["summary"]), "label": "Day notes written" if day and day["summary"]
         else "No day notes (optional)", "optional": True},
    ]


@app.get("/api/day/{ds}/close")
def close_check(ds: str):
    return {"checklist": close_checklist(ds), "job": planner.close_jobs().get(ds)}


@app.post("/api/day/{ds}/close")
async def close(ds: str, body: CloseIn | None = None):
    if state.day_status(ds) != "active":
        raise state.Refused("Only today can be closed.")
    open_items = [c for c in close_checklist(ds) if not c["ok"] and not c.get("optional")]
    if open_items and not (body and body.confirm):
        raise state.Refused("Not everything is finished: " + "; ".join(c["label"] for c in open_items) + ".")
    spawn(planner.close_day(ds), f"close_{ds}")
    return {"ok": True}


class NotesIn(BaseModel):
    text: str


@app.put("/api/day/{ds}/notes")
def day_notes(ds: str, body: NotesIn):
    state.set_day_notes(ds, body.text)
    return {"ok": True}


# ------------------------------------------------------------------ chat
@app.get("/api/chat")
def chat_get():
    return agent.chat_log(today().isoformat())


class ChatIn(BaseModel):
    text: str
    convo_id: int | None = None
    new: bool = False


def _chat_checks(body: ChatIn) -> tuple[str, int]:
    if not has_api_key():
        raise state.Refused("The agent needs ANTHROPIC_API_KEY: add it to ctu-app/.env and restart the server.")
    text = body.text.strip()
    if not text:
        raise state.Refused("Empty message.")
    return text[:4000], agent.prepare(body.convo_id, body.new)


@app.post("/api/chat")
async def chat_post(body: ChatIn):
    """Non-streaming fallback."""
    text, cid = _chat_checks(body)
    try:
        reply = await agent.chat(text, cid)
    except Exception as e:
        raise HTTPException(502, f"Agent error: {e}")
    return {"reply": reply, "convo_id": cid}


@app.post("/api/chat/stream")
async def chat_stream(body: ChatIn):
    text, cid = _chat_checks(body)

    async def gen():
        async for ev in agent.chat_events(text, cid):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.delete("/api/chat/{mid}")
def chat_delete(mid: int):
    coach.delete_message(mid)
    bus.publish("chat", {"state": "deleted"})
    return {"ok": True}


# ------------------------------------------------------------------ conversations
class ConvoIn(BaseModel):
    title: str = ""


@app.get("/api/convos")
def convos_list():
    return {"convos": coach.convos(), "default": coach.default_convo(), "today": today().isoformat()}


@app.post("/api/convos")
def convos_create(body: ConvoIn):
    return coach.convo(coach.create_convo(body.title))


@app.get("/api/convos/{cid}")
def convo_get(cid: int):
    c = coach.convo(cid)
    if not c:
        raise HTTPException(404, "No such conversation.")
    return {**c, "messages": coach.messages(cid)}


@app.patch("/api/convos/{cid}")
def convo_rename(cid: int, body: ConvoIn):
    coach.rename_convo(cid, body.title)
    return coach.convo(cid)


@app.delete("/api/convos/{cid}")
def convo_delete(cid: int):
    coach.delete_convo(cid)
    bus.publish("chat", {"state": "deleted"})
    return {"ok": True}


# ------------------------------------------------------------------ coach settings
class CoachIn(BaseModel):
    name: str
    personality: str = ""
    verbosity: int = 2
    effort: str = "low"
    model: str = ""
    language: str = "auto"


class NoteIn(BaseModel):
    text: str


def _coach_view():
    return {**coach.settings(), "memory": coach.memory(), "verbosity_labels": coach.VERBOSITY, "effort_labels": coach.EFFORTS,
            "language_labels": coach.LANGUAGES, "model_options": coach.model_options(), "model_default": coach.default_model(),
            "model_active": coach.chat_model(), "provider": coach.provider()}


@app.get("/api/coach")
def coach_get():
    return _coach_view()


@app.put("/api/coach")
def coach_put(body: CoachIn):
    coach.save_settings(body.name, body.personality, body.verbosity, body.effort, body.model, body.language)
    bus.publish("coach", {})
    return _coach_view()


@app.post("/api/coach/avatar")
async def coach_avatar_put(request: Request):
    if int(request.headers.get("content-length") or 0) > coach.AVATAR_MAX:
        raise state.Refused("The picture is larger than 2 MB.")
    coach.save_avatar(await request.body(), request.headers.get("content-type", ""))
    bus.publish("coach", {})
    return {"coach_avatar": _avatar_url()}


@app.delete("/api/coach/avatar")
def coach_avatar_delete():
    coach.clear_avatar()
    bus.publish("coach", {})
    return {"coach_avatar": None}


@app.get("/api/coach/avatar/{name}")
def coach_avatar_get(name: str):
    return FileResponse(coach.avatar_path(name), headers={"Cache-Control": "private, max-age=31536000, immutable",
                                                          "X-Content-Type-Options": "nosniff"})


@app.post("/api/coach/memory")
def memory_add(body: NoteIn):
    coach.add_memory(body.text)
    return _coach_view()


@app.put("/api/coach/memory/{mid}")
def memory_edit(mid: int, body: NoteIn):
    coach.update_memory(mid, body.text)
    return _coach_view()


@app.delete("/api/coach/memory/{mid}")
def memory_delete(mid: int):
    coach.delete_memory(mid)
    return _coach_view()


# ------------------------------------------------------------------ tests
class GenIn(BaseModel):
    kind: str = "eod"
    task_id: int | None = None


@app.post("/api/tests/generate")
async def test_generate(body: GenIn):
    if body.kind not in ("eod", "c_quiz", "unit_quiz"):
        raise state.Refused("Unknown kind of test.")
    chapters = ""
    if body.kind == "c_quiz" and body.task_id:
        chapters = db.decode(state.get_task(body.task_id))["meta"].get("chapters", "")
    if body.kind == "unit_quiz":
        task = state.get_task(body.task_id) if body.task_id else None
        if not task or task["kind"] != "unit_quiz":
            raise state.Refused("A unit check belongs to its unit-check task.")
    tid = tests_eod.create(today().isoformat(), body.kind, body.task_id)
    spawn(tests_eod.fill(tid, chapters))
    return {"id": tid}


@app.post("/api/tests/{tid}/retry")
async def test_retry(tid: int):
    t = db.q1("SELECT * FROM tests WHERE id=?", (tid,))
    stuck = t and t["status"] == "generating" and not tests_eod.is_running(tid)
    if not t or (t["status"] != "failed" and not stuck):
        raise state.Refused("Only a failed generation can be retried.")
    db.ex("UPDATE tests SET status='generating', error=NULL WHERE id=?", (tid,))
    chapters = ""
    if t["task_id"]:
        chapters = db.decode(state.get_task(t["task_id"]))["meta"].get("chapters", "")
    spawn(tests_eod.fill(tid, chapters))
    return {"id": tid}


@app.get("/api/tests")
def tests_list():
    return db.q("SELECT id,date,kind,status,cancelled,used_sec,score,max,source,created_at FROM tests ORDER BY id DESC LIMIT 50")


@app.get("/api/tests/{tid}")
def test_get(tid: int):
    return tests_eod.public_view(tid)


@app.post("/api/tests/{tid}/start")
def test_start(tid: int):
    tests_eod.start(tid)
    return tests_eod.public_view(tid)


class Answers(BaseModel):
    answers: dict[str, str]


@app.put("/api/tests/{tid}/answers")
def test_answers(tid: int, body: Answers):
    tests_eod.save_answers(tid, body.answers)
    return {"ok": True}


@app.post("/api/tests/{tid}/exit")
def test_exit(tid: int, body: Answers):
    return tests_eod.leave(tid, body.answers)


@app.post("/api/tests/{tid}/submit")
async def test_submit(tid: int, body: Answers):
    return await tests_eod.submit(tid, body.answers)


class VoidIn(BaseModel):
    why: str = ""


@app.post("/api/tests/{tid}/questions/{qid}/void")
def test_void(tid: int, qid: str, body: VoidIn):
    return tests_eod.void_question(tid, qid, body.why)


# ------------------------------------------------------------------ files
@app.get("/api/kintsugi/file")
def kintsugi_file(path: str):
    p = (KINTSUGI / path).resolve()
    if KINTSUGI.resolve() not in p.parents or not p.is_file():
        raise HTTPException(404)
    return {"path": path, "content": p.read_text(errors="replace")}


class OpenIn(BaseModel):
    path: str


@app.post("/api/open")
def open_path(body: OpenIn):
    p = (STUDY_REPO / body.path).resolve()
    if STUDY_REPO.resolve() not in (p, *p.parents):
        raise state.Refused("Path is outside the repo.")
    # opens the nearest folder that exists; the app doesn't create anything in the repo
    target = p
    while not target.exists() and target != STUDY_REPO.resolve():
        target = target.parent
    subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"opened": str(target), "exists": p.exists()}


# ------------------------------------------------------------------ insights (read only)
@app.get("/api/dashboard")
def get_dashboard():
    return insights.dashboard()


@app.get("/api/activity")
def get_activity():
    return insights.activity()


@app.get("/api/calendar/{month}")
def get_calendar(month: str):
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(400, "month=YYYY-MM")
    return insights.calendar(month)


@app.get("/api/progress")
def get_progress():
    return insights.progress()


@app.get("/api/history")
def get_history(days: int = 30, before: str | None = None):
    return insights.history(max(1, min(days, 120)), before)


@app.get("/api/profile")
def get_profile():
    return insights.profile()


# ------------------------------------------------------------------ the local account
class MeName(BaseModel):
    name: str


class MeGithub(BaseModel):
    github: str


@app.get("/api/me")
def me_get():
    return account.get()


@app.put("/api/me")
def me_put(body: MeName):
    out = account.save_name(body.name)
    bus.publish("me", {})
    return out


@app.put("/api/me/github")
def me_github(body: MeGithub):
    out = account.set_github(body.github)
    bus.publish("me", {})
    return out


@app.post("/api/me/photo")
async def me_photo_put(request: Request):
    if int(request.headers.get("content-length") or 0) > account.PHOTO_MAX:
        raise state.Refused("The picture is larger than 2 MB.")
    out = account.save_photo(await request.body(), request.headers.get("content-type", ""))
    bus.publish("me", {})
    return out


@app.delete("/api/me/photo")
def me_photo_delete():
    out = account.clear_photo()
    bus.publish("me", {})
    return out


@app.get("/api/me/photo/{name}")
def me_photo(name: str):
    return FileResponse(account.photo_path(name), headers={"Cache-Control": "private, max-age=31536000, immutable",
                                                           "X-Content-Type-Options": "nosniff"})


# ------------------------------------------------------------------ backup file (export / restore)
def _scratch() -> Path:
    d = DATA_DIR / ".transfer"
    d.mkdir(parents=True, exist_ok=True)
    return d


@app.post("/api/backup/export")
def backup_export():
    """The whole install as one zip. POST (with X-CTU), so another site can't make the browser fetch it."""
    name = backup.file_name()
    out = backup.export(_scratch() / f"{secrets.token_hex(8)}.zip")
    return FileResponse(out, media_type="application/zip", filename=name,
                        background=BackgroundTask(out.unlink, missing_ok=True))


@app.post("/api/backup/restore")
async def backup_restore(request: Request):
    if int(request.headers.get("content-length") or 0) > backup.MAX_UPLOAD:
        raise state.Refused("This backup is too large to restore.")
    src = _scratch() / f"{secrets.token_hex(8)}.zip"
    try:
        size = 0
        with open(src, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > backup.MAX_UPLOAD:
                    raise state.Refused("This backup is too large to restore.")
                f.write(chunk)
        # runs on the event loop on purpose: nothing else touches the database while it is swapped
        out = backup.restore(src)
    finally:
        src.unlink(missing_ok=True)
    # the backup may have been taken mid-task or mid-test: settle it the way a server start does
    state.pause_all("restore")
    tests_eod.fail_interrupted()
    spawn(planner.ensure_horizon(), "horizon")
    planlog.write()
    bus.publish("restored", {})
    return out


# ------------------------------------------------------------------ the plan and onboarding
@app.get("/api/plan")
def plan_get():
    """The active plan as the app runs it (Settings → Plan shows it)."""
    p = profile.active()
    return {"key": profile.key(), "ready": profile.ready(), "engine": profile.engine(), "label": p.get("label", ""),
            "summary": p.get("summary", ""), "start_date": p.get("start_date"), "study_weekdays": p.get("study_weekdays", []),
            "week": p.get("week", []), "tracks": p.get("tracks", []), "goals": p.get("goals", []),
            "thresholds": p.get("thresholds", {}), "roadmap": insights.roadmap(), "modules": p.get("modules", []),
            "approved_at": p.get("approved_at"), "plan_md": str(planlog.path()) if planlog.path().is_file() else None,
            "progress": tracks.progress() if profile.key() == "custom" else [],
            "answers": p.get("answers", {}), "deadline": p.get("deadline") or None, "end_date": p.get("end_date") or None,
            "projected_end": tracks.projection().get("projected_end") if profile.key() == "custom" else None,
            "track_ends": tracks.projection().get("track_ends", {}) if profile.key() == "custom" else {}}


class ExamsIn(BaseModel):
    dates: dict[str, str]


@app.put("/api/plan/exams")
async def plan_exams(body: ExamsIn):
    """Exam dates per course on the approved plan ('' removes one)."""
    out = onboarding.set_exams(body.dates)
    spawn(planner.ensure_horizon(), "horizon")
    return out


@app.get("/api/plan/file")
def plan_file():
    p = planlog.write()
    if not p:
        raise state.Refused("Only a custom plan has a PLAN.md.")
    return FileResponse(p, media_type="text/markdown; charset=utf-8", filename="PLAN.md")


class DraftIn(BaseModel):
    answers: dict


class ChangeIn(BaseModel):
    change: str


class ApproveIn(BaseModel):
    confirm: bool = False


@app.get("/api/onboarding")
def onboarding_get():
    return onboarding.status()


@app.post("/api/onboarding/draft")
async def onboarding_draft(body: DraftIn):
    out = onboarding.start(body.answers)
    spawn(onboarding.run(), "onboarding")
    return out


@app.post("/api/onboarding/change")
async def onboarding_change(body: ChangeIn):
    out = onboarding.start({}, change=body.change)
    spawn(onboarding.run(), "onboarding")
    return out


@app.post("/api/onboarding/discard")
def onboarding_discard():
    return onboarding.discard()


@app.post("/api/onboarding/approve")
async def onboarding_approve(body: ApproveIn):
    out = onboarding.approve(body.confirm)
    spawn(planner.ensure_horizon(), "horizon")
    return out


# ------------------------------------------------------------------ the user's own API key
class KeyIn(BaseModel):
    key: str


@app.get("/api/settings/key")
def key_get():
    return keys.info()


@app.put("/api/settings/key")
async def key_put(body: KeyIn):
    out = await keys.save(body.key)
    bus.publish("meta", {})
    return out


@app.delete("/api/settings/key")
def key_delete():
    out = keys.remove()
    bus.publish("meta", {})
    return out


@app.get("/api/xp")
def get_xp():
    return xp.summary()


# ------------------------------------------------------------------ notebook (the user's own pages)
class NewPage(BaseModel):
    title: str = ""
    kind: str = "doc"


class PagePatch(BaseModel):
    title: str | None = None
    body: dict | None = None
    topic: str | None = None


@app.get("/api/notes")
def notes_list():
    return {"pages": notes.pages()}


@app.post("/api/notes")
def notes_create(body: NewPage):
    return notes.create(body.title, body.kind)


@app.get("/api/notes/about")
def notes_about(topic: str = ""):
    return {"pages": notes.about(topic), "choices": notes.topic_choices() if not topic else []}


@app.get("/api/notes/{pid}")
def notes_get(pid: int):
    return notes.get(pid)


@app.put("/api/notes/{pid}")
def notes_save(pid: int, body: PagePatch):
    return notes.save(pid, body.title, body.body, body.topic)


@app.delete("/api/notes/{pid}")
def notes_delete(pid: int):
    notes.delete(pid)
    return {"ok": True}


@app.post("/api/notes-assets")
async def notes_upload(request: Request):
    if int(request.headers.get("content-length") or 0) > notes.MAX_ASSET:
        raise state.Refused("The image is larger than 12 MB.")
    data = await request.body()
    return {"name": notes.save_asset(data, request.headers.get("content-type", ""))}


@app.get("/api/notes-assets/{name}")
def notes_asset(name: str):
    p = notes.asset_path(name)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=31536000, immutable",
                                    "X-Content-Type-Options": "nosniff"})


class Goal(BaseModel):
    label: str
    target: str
    note: str = ""


class Goals(BaseModel):
    goals: list[Goal]


@app.put("/api/goals")
def put_goals(body: Goals):
    """Profile goals are display-only text; thresholds and the plan are not touched here."""
    rows = [g.model_dump() for g in body.goals if g.label.strip()][:12]
    for g in rows:
        g.update({k: v.strip()[:120] for k, v in g.items()})
    db.kv_set("goals", rows)
    return {"goals": insights.goals()}


# ------------------------------------------------------------------ live
@app.get("/api/stream")
async def stream(request: Request):
    q = bus.subscribe()

    async def gen():
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------------ Khan content (Kolibri)
class KhanCheck(BaseModel):
    item_id: str
    answers: dict = {}


class KhanItem(BaseModel):
    item_id: str


class KhanAnswers(BaseModel):
    answers: dict = {}


class KhanTestIn(BaseModel):
    task_id: int


@app.get("/api/khan/status")
def khan_status():
    return khan.status()


@app.get("/api/khan/unit/{idx}")
def khan_unit_view(idx: int):
    return khan.outline(idx)


@app.post("/api/khan/unit/{idx}/download")
def khan_download(idx: int):
    if not khan.request_download(idx):
        raise state.Refused("Kolibri isn't installed. " + khan.SETUP_HINT)
    return khan.status()


@app.get("/api/khan/video/{node_id}")
def khan_video(node_id: str):
    return khan.video(node_id)


_KHAN_FILE_HEADERS = {"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"}


@app.get("/api/khan/file/{name}")
def khan_file(name: str):
    return FileResponse(khan.file_path(name), headers=_KHAN_FILE_HEADERS)


@app.get("/api/khan/img/{ex_id}/{name}")
def khan_img(ex_id: str, name: str):
    from fastapi.responses import Response
    data, ctype = khan.zip_file(ex_id, name)
    # an svg opened on its own must not run anything on this origin
    return Response(data, media_type=ctype, headers=_KHAN_FILE_HEADERS | {
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"})


@app.get("/api/khan/graphie/{ex_id}/{h}")
def khan_graphie(ex_id: str, h: str):
    return khan.graphie(ex_id, h)


@app.get("/api/khan/exercise/{ex_id}")
def khan_exercise(ex_id: str):
    return khan.next_item(ex_id)


@app.post("/api/khan/exercise/{ex_id}/check")
def khan_check(ex_id: str, body: KhanCheck):
    return khan.check(ex_id, body.item_id, body.answers)


@app.post("/api/khan/exercise/{ex_id}/hint")
def khan_hint(ex_id: str, body: KhanItem):
    return khan.hint(ex_id, body.item_id)


@app.post("/api/khan/exercise/{ex_id}/reveal")
def khan_reveal(ex_id: str, body: KhanItem):
    return khan.reveal(ex_id, body.item_id)


@app.post("/api/khan/tests")
def khan_test_start(body: KhanTestIn):
    return {"id": khan.start_test(body.task_id)}


@app.get("/api/khan/tests/{tid}")
def khan_test_view(tid: int):
    return khan.get_test(tid)


@app.put("/api/khan/tests/{tid}/answers")
def khan_test_answers(tid: int, body: KhanAnswers):
    khan.save_test_answers(tid, body.answers)
    return {"ok": True}


@app.post("/api/khan/tests/{tid}/submit")
def khan_test_submit(tid: int, body: KhanAnswers):
    return khan.submit_test(tid, body.answers)


# ------------------------------------------------------------------ notifications
class NoticeIn(BaseModel):
    title: str
    body: str = ""
    tone: str = "info"
    link: str | None = None


@app.get("/api/notices")
def notices_list(limit: int = 100):
    return notices.listing(limit)


@app.post("/api/notices")
def notices_add(body: NoticeIn):
    if not body.title.strip():
        raise state.Refused("A notice needs a title.")
    return notices.add("client", body.title, body.body, body.tone, body.link, source="client")


@app.post("/api/notices/read")
def notices_read_all():
    notices.mark_read()
    return {"ok": True}


@app.post("/api/notices/{nid}/read")
def notices_read(nid: int):
    notices.mark_read(nid)
    return {"ok": True}


@app.delete("/api/notices")
def notices_clear():
    notices.delete()
    return {"ok": True}


@app.delete("/api/notices/{nid}")
def notices_delete(nid: int):
    notices.delete(nid)
    return {"ok": True}


# ------------------------------------------------------------------ frontend
DIST = APP_ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")
    _DIST_ROOT = DIST.resolve()

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        f = (_DIST_ROOT / full_path).resolve()
        # only files inside frontend/dist; '../' and absolute paths fall back to the app page
        if full_path and _DIST_ROOT in f.parents and f.is_file():
            return FileResponse(f)
        return FileResponse(_DIST_ROOT / "index.html")

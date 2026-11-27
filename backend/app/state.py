"""Day/task state, locking, timers, scores and stuck-points."""
from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timedelta

from . import bus, db, files, profile
from .config import (STUDY_REPO, WEEKDAY_TR, WEEKDAY_TR_SHORT, now, start_date, study_weekdays, today, week_start,
                     week_index)
from .curriculum import khan_item, khan_unit

log = logging.getLogger("ctu.state")

# A running timer only counts time while someone is there. If nothing was heard for this long (the open app
# pings every minute; file saves, compiles and reader activity count too), the laptop slept or the app was
# closed: the timer stops counting GRACE_MIN after the last sign of life.
AWAY_MIN = 30
GRACE_MIN = 5


class Refused(Exception):
    """Action not allowed; message is shown to the user as-is."""


# ---------------------------------------------------------------- events
def log_event(type_: str, task_id: int | None = None, data: dict | None = None, d: date | None = None) -> None:
    db.ex("INSERT INTO events(ts,date,task_id,type,data) VALUES(?,?,?,?,?)",
          (db.ts(), (d or today()).isoformat(), task_id, type_, json.dumps(data or {}, ensure_ascii=False)))
    bus.publish("event", {"type": type_, "task_id": task_id})


def add_stuck(source: str, summary: str, task_id: int | None = None, detail: str = "",
              dedupe_min: int = 30) -> int | None:
    since = (now() - timedelta(minutes=dedupe_min)).isoformat(timespec="seconds")
    dup = dedupe_min > 0 and db.q1(
        "SELECT id FROM stuck WHERE source=? AND IFNULL(task_id,-1)=IFNULL(?,-1) AND resolved=0 AND ts>=?",
        (source, task_id, since))
    if dup:
        return None
    sid = db.ex("INSERT INTO stuck(ts,date,task_id,source,summary,detail) VALUES(?,?,?,?,?,?)",
                (db.ts(), today().isoformat(), task_id, source, summary, detail))
    bus.publish("stuck", {"id": sid, "summary": summary, "source": source, "task_id": task_id})
    from . import notices
    notices.safe_add("stuck", "Sticking point", summary, tone="warn", link=f"#/day/{today().isoformat()}")
    return sid


# ---------------------------------------------------------------- locking
def day_status(ds: str) -> str:
    d = date.fromisoformat(ds)
    if not profile.is_study_day(d):
        return "off"
    t = today()
    if d > t:
        return "locked"
    if d == t:
        row = db.q1("SELECT status FROM days WHERE date=?", (ds,))
        return "closed" if row and row["status"] == "closed" else "active"
    return "past"


def require_active(ds: str) -> None:
    st = day_status(ds)
    if st == "locked":
        raise Refused("This day is locked. Finish today first; it unlocks that morning.")
    if st in ("past", "closed"):
        raise Refused("This day is closed and read-only.")
    if st == "off":
        raise Refused("There is no study on this weekday in your plan." if study_weekdays() else
                      "There is no plan yet: set one up first.")


# ---------------------------------------------------------------- reading
def last_alive(t: dict) -> datetime:
    """Latest sign that the user was around while this task ran."""
    times = [t["started_at"], db.kv_get("last_seen"), db.kv_get("last_site_input")]
    ev = db.q1("SELECT MAX(ts) ts FROM events WHERE task_id=? AND type IN "
               "('file_change','compile_ok','compile_fail','start','reader_activity')", (t["id"],))
    times.append(ev["ts"] if ev else None)
    started = datetime.fromisoformat(t["started_at"])
    return max([started] + [datetime.fromisoformat(x) for x in times if x])


def _run_end(t: dict) -> tuple[datetime, bool]:
    """When the current run of a 'doing' task ends for counting: now, or shortly after the last sign of life."""
    end = now()
    alive = last_alive(t)
    if end - alive > timedelta(minutes=AWAY_MIN):
        return max(alive + timedelta(minutes=GRACE_MIN), datetime.fromisoformat(t["started_at"])), True
    return end, False


def _live_spent(t: dict) -> int:
    s = t["spent_sec"]
    if t["status"] == "doing" and t["started_at"]:
        end, _ = _run_end(t)
        s += int((end - datetime.fromisoformat(t["started_at"])).total_seconds())
    return max(s, 0)


def task_view(t: dict) -> dict:
    t = db.decode(t)
    t["spent_sec_live"] = _live_spent(t)
    last = db.q1("SELECT type,data,ts FROM events WHERE task_id=? AND type IN ('compile_ok','compile_fail') "
                 "ORDER BY id DESC LIMIT 1", (t["id"],))
    t["compile"] = db.decode(last) if last else None
    t["files_exist"] = {f: (STUDY_REPO / f).exists() for f in t["files"]}
    sc = db.q1("SELECT value,max,threshold,passed FROM scores WHERE task_id=? ORDER BY id DESC LIMIT 1", (t["id"],))
    t["score"] = sc
    return t


def get_day(ds: str, *, reveal: bool | None = None) -> dict:
    st = day_status(ds)
    day = db.q1("SELECT * FROM days WHERE date=?", (ds,))
    d = date.fromisoformat(ds)
    base = {"date": ds, "status": st, "weekday": WEEKDAY_TR[d.weekday()], "week": week_index(d),
            "exists": bool(day)}
    like = profile.extra_days().get(ds) if d.weekday() not in study_weekdays() else None
    if like is not None:
        # a one-off study day the user added; it can be taken back until it is worked on
        from .planner import touched
        base["extra"] = {"like": like, "removable": d >= today() and st != "closed" and not touched(ds)}
    elif st == "off" and profile.key() == "custom" and d >= today() and d >= start_date():
        base["can_add"] = sorted(study_weekdays())   # the study weekdays whose blocks it could copy
    if st == "locked" and not reveal:
        # Locked days only show their name; content stays hidden until the day opens.
        from . import tracks
        return base | {"version": day["version"] if day else None, "outline": tracks.outline(d)}
    if not day:
        return base
    blocks = db.q("SELECT * FROM blocks WHERE date=? ORDER BY ord", (ds,))
    tasks = [task_view(t) for t in db.q("SELECT * FROM tasks WHERE date=? ORDER BY block_id, ord", (ds,))]
    for b in blocks:
        b["tasks"] = [t for t in tasks if t["block_id"] == b["id"]]
    stuck = db.q("SELECT * FROM stuck WHERE date=? ORDER BY id DESC", (ds,))
    test = db.q1("SELECT id,status,score,max,source FROM tests WHERE date=? AND kind<>'practice' ORDER BY id DESC LIMIT 1", (ds,))
    total_est = sum(t["est_min"] for t in tasks)
    done_est = sum(t["est_min"] for t in tasks if t["status"] == "done")
    return base | {
        "version": day["version"], "title": day["title"], "adapt_note": day["adapt_note"],
        "summary": day["summary"], "blocks": blocks, "stuck": stuck, "test": test,
        "progress": {"done": sum(t["status"] == "done" for t in tasks), "total": len(tasks),
                     "est_done_min": done_est, "est_total_min": total_est,
                     "spent_sec": sum(t["spent_sec_live"] for t in tasks)},
    }


def overview() -> dict:
    """Weeks that have at least one generated day. Off days are shown greyed."""
    rows = db.q("SELECT date,version,status FROM days ORDER BY date")
    weeks: dict[int, list[dict]] = {}
    for r in rows:
        d = date.fromisoformat(r["date"])
        weeks.setdefault(week_index(d), [])
    out = []
    for w in sorted(weeks):
        start = week_start() + timedelta(days=7 * w)
        days = []
        for i in range(7):
            d = start + timedelta(days=i)
            ds = d.isoformat()
            row = next((r for r in rows if r["date"] == ds), None)
            if not profile.is_study_day(d):
                days.append({"date": ds, "short": WEEKDAY_TR_SHORT[i], "status": "off"})
            elif row:
                days.append({"date": ds, "short": WEEKDAY_TR_SHORT[i], "status": day_status(ds),
                             "version": row["version"]})
        out.append({"week": w, "start": start.isoformat(), "days": days})
    return {"today": today().isoformat(), "now": now().isoformat(timespec="seconds"),
            "start_date": start_date().isoformat(), "weeks": out}


# ---------------------------------------------------------------- timers
def _stop(t: dict) -> bool:
    """Stop a running task's clock. Returns True if time was cut because nobody was around."""
    if t["status"] == "doing" and t["started_at"]:
        end, capped = _run_end(t)
        add = int((end - datetime.fromisoformat(t["started_at"])).total_seconds())
        db.ex("UPDATE tasks SET spent_sec=spent_sec+?, started_at=NULL, status='todo' WHERE id=?", (max(add, 0), t["id"]))
        if capped:
            log.info("task %s: stopped at the last sign of activity, not now", t["id"])
        return capped
    return False


def pause_away() -> list[int]:
    """Pause running tasks whose user is gone (laptop asleep, app closed). Used by the tick loop and at startup."""
    out = []
    for t in db.q("SELECT * FROM tasks WHERE status='doing'"):
        if _run_end(t)[1]:
            _stop(t)
            log_event("pause", t["id"], {"reason": "away"}, d=date.fromisoformat(t["date"]))
            out.append(t["id"])
    return out


def pause_all(reason: str) -> None:
    for t in db.q("SELECT * FROM tasks WHERE status='doing'"):
        _stop(t)
        log_event("pause", t["id"], {"reason": reason}, d=date.fromisoformat(t["date"]))


def get_task(task_id: int) -> dict:
    t = db.q1("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not t:
        raise Refused("No such task.")
    return t


def start_task(task_id: int) -> None:
    t = get_task(task_id)
    require_active(t["date"])
    if t["status"] == "done":
        raise Refused("Task is already done. Use Undo to reopen it.")
    for other in db.q("SELECT * FROM tasks WHERE status='doing' AND id<>?", (task_id,)):
        _stop(other)
        log_event("pause", other["id"], {"reason": "switch"})
    db.ex("UPDATE tasks SET status='doing', started_at=?, first_started_at=IFNULL(first_started_at, ?) WHERE id=?",
          (db.ts(), db.ts(), task_id))
    log_event("start", task_id)
    _check_switching()


def pause_task(task_id: int) -> None:
    t = get_task(task_id)
    require_active(t["date"])
    _stop(t)
    log_event("pause", task_id)
    _check_pausing(task_id)


def complete_task(task_id: int) -> dict:
    t = db.decode(get_task(task_id))
    require_active(t["date"])
    warnings: list[str] = []
    if t["kind"] == "exercise":
        for f in t["files"]:
            p = STUDY_REPO / f
            if not p.exists():
                add_stuck("wrong_check", f"Tried to mark done while {f} does not exist", task_id)
                raise Refused(f"{f} is not in the repo. It can't count as done before the file exists.")
            last = db.q1("SELECT type,data FROM events WHERE task_id=? AND type IN ('compile_ok','compile_fail') "
                         "ORDER BY id DESC LIMIT 1", (task_id,))
            if not last or last["type"] != "compile_ok":
                add_stuck("wrong_check", f"Tried to mark done before {f} compiled cleanly", task_id)
                raise Refused(f"{f} does not compile cleanly with -Wall -Wextra -Werror (or was never compiled). "
                              "Save the file so the app compiles it.")
    if t["kind"] in ("write", "rewrite"):
        for f in t["files"]:
            p = STUDY_REPO / f
            if not p.exists() or p.stat().st_size < 40:
                raise Refused(f"{f} is missing or nearly empty.")
    if t["kind"] == "khan_test":
        if not db.q1("SELECT 1 FROM scores WHERE task_id=?", (task_id,)):
            raise Refused("Enter the unit test score first.")
    if t["kind"] == "unit_quiz" and not db.q1("SELECT 1 FROM scores WHERE task_id=?", (task_id,)):
        from .config import has_api_key
        if has_api_key():   # without a key the check can't be written; the task can still be ticked off
            raise Refused("Take the unit check first (Prepare check).")
    _stop(db.q1("SELECT * FROM tasks WHERE id=?", (task_id,)))
    spent = db.q1("SELECT spent_sec FROM tasks WHERE id=?", (task_id,))["spent_sec"]
    if t["kind"] in ("read", "kintsugi_read") and spent < t["est_min"] * 60 * 0.25:
        add_stuck("wrong_check",
                  f"'{t['title']}' marked done in under 25% of its estimate ({spent // 60} min / {t['est_min']} min)",
                  task_id, "Was it really read? The end-of-day test will ask about it.")
        warnings.append("Done that fast? The end-of-day test will ask about it.")
    db.ex("UPDATE tasks SET status='done', done_at=? WHERE id=?", (db.ts(), task_id))
    log_event("done", task_id, {"spent_sec": spent})
    return {"warnings": warnings}


def reopen_task(task_id: int) -> None:
    t = get_task(task_id)
    require_active(t["date"])
    db.ex("UPDATE tasks SET status='todo', done_at=NULL WHERE id=?", (task_id,))
    log_event("reopen", task_id)


# ---------------------------------------------------------------- scores
def record_khan_score(task_id: int, percent: float) -> dict:
    t = db.decode(get_task(task_id))
    require_active(t["date"])
    if not 0 <= percent <= 100:
        raise Refused("Score must be between 0 and 100.")
    idx = int(t["meta"].get("unit_idx", 0))
    unit = khan_unit(idx)["name"]
    thr = profile.thresholds()["khan_unit"]["threshold"]
    passed = percent >= thr
    # score, cursor and sticking points land together; the log file comes after and can't undo them
    with db.tx():
        db.ex("INSERT INTO scores(ts,date,task_id,kind,item,value,max,threshold,passed) VALUES(?,?,?,?,?,?,?,?,?)",
              (db.ts(), t["date"], task_id, "khan_unit", khan_item(idx), percent, 100, thr, int(passed)))
        log_event("score", task_id, {"unit": unit, "percent": percent, "passed": passed})
        cursor = db.kv_get("cursor", {})
        if passed:
            cursor["khan_unit"] = max(cursor.get("khan_unit", 0), idx + 1)
            db.kv_set("cursor", cursor)
            msg = f"Passed (≥{thr}%). {unit} counts as done."
            if _skip_unit_study(t["date"], idx, percent):
                msg += " Its lessons + exercises task isn't needed and is ticked off."
        else:
            add_stuck("low_score", f"{unit} unit test {percent:g}% (threshold {thr}%)", task_id)
            msg = f"Below threshold ({thr}%). Study the unit, then retake the test."
            _unskip_unit_study(t["date"], idx)
            if percent < 50 and idx == 0:
                add_stuck("low_score", "Algebra foundations below 50% → check Pre-algebra", task_id)
                msg += " Below 50%: the agent will pick missing Pre-algebra topics."
    try:
        _write_math_log(t["date"], unit, percent, passed)
    except OSError as e:
        log.exception("math/log.md write failed")
        msg += f" (The score is saved, but math/log.md could not be written: {e.strerror or e}.)"
    return {"passed": passed, "message": msg}


def _unit_study_tasks(ds: str, idx: int) -> list[dict]:
    """The day's "lessons + exercises" task for a unit: Khan study for that unit, not one that carries its own test."""
    return [t for t in (db.decode(r) for r in db.q("SELECT * FROM tasks WHERE date=? AND kind='khan_study'", (ds,)))
            if int(t["meta"].get("unit_idx", -1)) == idx and t["meta"].get("score_kind") != "khan_unit"]


def _skip_unit_study(ds: str, idx: int, percent: float) -> bool:
    """A passed unit test makes the unit's study task unnecessary ("only if the test is below the threshold"):
    tick it off, marked as skipped so a later failed retake can open it again."""
    done = False
    for t in _unit_study_tasks(ds, idx):
        if t["status"] == "done":
            continue
        _stop(db.q1("SELECT * FROM tasks WHERE id=?", (t["id"],)))
        meta = {**t["meta"], "skipped": {"reason": "unit_passed", "percent": percent}}
        db.ex("UPDATE tasks SET status='done', done_at=?, meta=? WHERE id=?",
              (db.ts(), json.dumps(meta, ensure_ascii=False), t["id"]))
        log_event("skip", t["id"], {"reason": "unit_passed", "percent": percent})
        done = True
    return done


def _unskip_unit_study(ds: str, idx: int) -> None:
    """A retake below the threshold: the study task that was skipped for the earlier pass is needed after all."""
    for t in _unit_study_tasks(ds, idx):
        if t["status"] == "done" and t["meta"].get("skipped"):
            meta = {k: v for k, v in t["meta"].items() if k != "skipped"}
            db.ex("UPDATE tasks SET status='todo', done_at=NULL, meta=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), t["id"]))
            log_event("reopen", t["id"], {"reason": "unit_retake_below"})


MATH_LOG_HEAD = "# Khan Academy log\n\n| Tarih | Ünite | Unit test | Sonuç |\n|---|---|---|---|\n"


def math_log_text(old: str | None, ds: str, unit: str, percent: float, passed: bool) -> str:
    """One row per date and unit: entering the score again replaces that day's row instead of adding a second."""
    row = f"| {ds} | {unit} | %{percent:g} | {'geçti' if passed else 'tekrar'} |"
    text = old if old is not None else MATH_LOG_HEAD
    pat = re.compile(rf"^\| {re.escape(ds)} \| {re.escape(unit)} \|[^\n]*$", re.M)
    if pat.search(text):
        return pat.sub(lambda _m: row, text, count=1)
    return text.rstrip("\n") + "\n" + row + "\n"


def _write_math_log(ds: str, unit: str, percent: float, passed: bool) -> None:
    files.rewrite(STUDY_REPO / "math" / "log.md", lambda old: math_log_text(old, ds, unit, percent, passed),
                  action="khan score")


# ---------------------------------------------------------------- boredom heuristics
def _check_switching() -> None:
    since = (now() - timedelta(minutes=20)).isoformat(timespec="seconds")
    n = db.q1("SELECT COUNT(*) c FROM events WHERE type='start' AND ts>=?", (since,))["c"]
    if n >= 5:
        add_stuck("boredom", f"Switched tasks {n} times in the last 20 minutes",
                  detail="Frequent switching can be a sign of lost focus or boredom.", dedupe_min=40)


def _check_pausing(task_id: int) -> None:
    since = (now() - timedelta(minutes=30)).isoformat(timespec="seconds")
    n = db.q1("SELECT COUNT(*) c FROM events WHERE type='pause' AND task_id=? AND ts>=?", (task_id, since))["c"]
    if n >= 4:
        add_stuck("boredom", f"Same task paused {n} times in 30 minutes", task_id, dedupe_min=40)


def resolve_stuck(sid: int) -> None:
    db.ex("UPDATE stuck SET resolved=1 WHERE id=?", (sid,))
    bus.publish("stuck_resolved", {"id": sid})


def current_task() -> dict | None:
    t = db.q1("SELECT * FROM tasks WHERE status='doing' ORDER BY started_at DESC LIMIT 1")
    return task_view(t) if t else None


def minutes_on_task(task_id: int) -> int:
    t = db.q1("SELECT * FROM tasks WHERE id=?", (task_id,))
    return _live_spent(t) // 60 if t else 0


# ---------------------------------------------------------------- day notes
def _notes_changed(ds: str) -> None:
    """A closed day's notes live in its PROGRESS.md section too: rewrite that section."""
    row = db.q1("SELECT status FROM days WHERE date=?", (ds,))
    if row and row["status"] == "closed":
        from . import health
        from .planner import write_progress
        try:
            write_progress(ds)
            health.clear(f"notes_{ds}")
        except Exception as e:  # noqa: BLE001
            log.exception("PROGRESS.md update for notes failed")
            health.warn(f"notes_{ds}", f"Notes for {ds} are saved but PROGRESS.md could not be updated: {e}")


def add_day_note(ds: str, text: str) -> bool:
    row = db.q1("SELECT summary FROM days WHERE date=?", (ds,))
    if not row:
        return False
    db.ex("UPDATE days SET summary=? WHERE date=?", (((row["summary"] or "") + "\n- " + text.strip()).strip(), ds))
    _notes_changed(ds)
    bus.publish("plan", {"date": ds})
    return True


def set_day_notes(ds: str, text: str) -> None:
    if day_status(ds) in ("locked", "off") or not db.q1("SELECT 1 FROM days WHERE date=?", (ds,)):
        raise Refused("Notes can be written for today and earlier study days only.")
    db.ex("UPDATE days SET summary=? WHERE date=?", (text.strip()[:4000] or None, ds))
    _notes_changed(ds)
    bus.publish("plan", {"date": ds})

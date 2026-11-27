"""Read-only aggregates for the dashboard, calendar, progress, history and profile views.

Nothing in here writes to the DB, the study repo or COACH.md.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from datetime import date, datetime, timedelta

from . import account, db, state
from . import profile as plan
from .config import COACH_MD, STUDY_REPO, WEEKDAY_TR_SHORT, now, start_date, study_weekdays, today, week_index, week_start
from .curriculum import BEEJ_CHAPTERS, KHAN_UNITS, KINTSUGI_ORDER, khan_item

YEAR_DAYS = 371  # 53 full weeks from the start Monday


# ---------------------------------------------------------------- git (read only)
_git_cache: dict = {"head": None, "rows": []}


def _git_head() -> str | None:
    try:
        r = subprocess.run(["git", "-C", str(STUDY_REPO), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() or None
    except Exception:
        return None


def git_log(limit: int = 500) -> list[dict]:
    """Commits of the study repo with short stats. Cached until HEAD moves."""
    head = _git_head()
    if head and head == _git_cache["head"]:
        return _git_cache["rows"][:limit]
    rows: list[dict] = []
    try:
        out = subprocess.run(
            ["git", "-C", str(STUDY_REPO), "log", f"-{limit}", "--no-color", "--shortstat",
             "--format=\x1e%H\x1f%h\x1f%aI\x1f%an\x1f%s"],
            capture_output=True, text=True, timeout=10).stdout
    except Exception:
        out = ""
    for chunk in out.split("\x1e")[1:]:
        head_line, _, rest = chunk.partition("\n")
        parts = head_line.split("\x1f")
        if len(parts) < 5:
            continue
        stat = rest.strip()
        nums = {k: int(v) for v, k in re.findall(r"(\d+) (file|insertion|deletion)", stat)}
        rows.append({"hash": parts[0], "short": parts[1], "ts": parts[2], "date": parts[2][:10],
                     "author": parts[3], "message": parts[4], "files": nums.get("file", 0),
                     "add": nums.get("insertion", 0), "del": nums.get("deletion", 0)})
    _git_cache.update(head=head, rows=rows)
    return rows[:limit]


# ---------------------------------------------------------------- helpers
def _meta(t: dict) -> dict:
    m = t.get("meta")
    if isinstance(m, str):
        try:
            return json.loads(m)
        except Exception:
            return {}
    return m or {}


def _live_spent(t: dict) -> int:
    s = t["spent_sec"]
    if t["status"] == "doing" and t["started_at"]:
        s += max(0, int((now() - datetime.fromisoformat(t["started_at"])).total_seconds()))
    return s


def _minutes_by_day() -> dict[str, int]:
    out: dict[str, int] = {}
    for t in db.q("SELECT date, spent_sec, status, started_at FROM tasks"):
        out[t["date"]] = out.get(t["date"], 0) + _live_spent(t)
    return {k: v // 60 for k, v in out.items()}


def _is_study(d: date) -> bool:
    return plan.is_study_day(d)


def _streaks(minutes: dict[str, int]) -> tuple[int, int]:
    """Consecutive study days (days off skipped) with at least 30 minutes of tracked work. A one-off study day added
    on a day off adds to the streak when it was studied, and never breaks it when it wasn't."""
    t = today()
    d, cur, best, run = start_date(), 0, 0, 0
    while d <= t:
        if _is_study(d):
            if minutes.get(d.isoformat(), 0) >= 30:
                run += 1
                best = max(best, run)
            elif d < t and d.weekday() in study_weekdays():  # today still counts as open
                run = 0
        d += timedelta(days=1)
    cur = run
    return cur, best


# ---------------------------------------------------------------- activity heatmap
def activity() -> dict:
    minutes = _minutes_by_day()
    ev = {r["date"]: r for r in db.q(
        "SELECT date, SUM(type='done') AS done, SUM(type='compile_ok') AS ok, SUM(type='compile_fail') AS fail, "
        "SUM(type='file_change') AS files FROM events GROUP BY date")}
    commits: dict[str, int] = {}
    for c in git_log():
        commits[c["date"]] = commits.get(c["date"], 0) + 1
    closed = {r["date"] for r in db.q("SELECT date FROM days WHERE status='closed'")}
    planned = {r["date"] for r in db.q("SELECT date FROM days")}
    t = today()
    days = []
    for i in range(YEAR_DAYS):
        d = week_start() + timedelta(days=i)
        ds = d.isoformat()
        e = ev.get(ds) or {}
        m = minutes.get(ds, 0)
        level = 0 if m == 0 else 1 if m < 120 else 2 if m < 300 else 3 if m < 480 else 4
        if not _is_study(d):
            st = "off"
        elif d > t:
            st = "future"
        elif ds in closed:
            st = "closed"
        elif d == t:
            st = "active"
        else:
            st = "past" if ds in planned else "none"
        days.append({"date": ds, "minutes": m, "done": int(e.get("done") or 0), "commits": commits.get(ds, 0),
                     "compiles": int(e.get("ok") or 0) + int(e.get("fail") or 0), "level": level, "status": st})
    return {"start": week_start().isoformat(), "today": t.isoformat(), "days": days}


# ---------------------------------------------------------------- calendar
def calendar(month: str) -> dict:
    """month = YYYY-MM. Every day of the month with status and day-level progress."""
    y, m = map(int, month.split("-"))
    first = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    minutes = _minutes_by_day()
    rows = {r["date"]: r for r in db.q(
        "SELECT d.date, d.version, d.status, d.title, COUNT(t.id) AS total, SUM(t.status='done') AS done, "
        "COALESCE(SUM(t.est_min),0) AS est FROM days d LEFT JOIN tasks t ON t.date=d.date "
        "WHERE d.date>=? AND d.date<? GROUP BY d.date", (first.isoformat(), nxt.isoformat()))}
    blocks: dict[str, list[str]] = {}
    for b in db.q("SELECT date, kind FROM blocks WHERE date>=? AND date<? AND kind NOT IN ('break','test') ORDER BY ord",
                  (first.isoformat(), nxt.isoformat())):
        if b["kind"] not in blocks.setdefault(b["date"], []):
            blocks[b["date"]].append(b["kind"])
    tests = {r["date"]: r for r in db.q("SELECT date, score, max FROM tests WHERE kind='eod' AND status='submitted'")}
    stuck = {r["date"]: r["n"] for r in db.q("SELECT date, COUNT(*) AS n FROM stuck GROUP BY date")}
    out = []
    d = first
    while d < nxt:
        ds = d.isoformat()
        r = rows.get(ds)
        st = state.day_status(ds)
        if st == "past" and r and r["status"] == "closed":
            st = "closed"
        if d < start_date() and _is_study(d):
            st = "before"
        out.append({"date": ds, "weekday": WEEKDAY_TR_SHORT[d.weekday()], "status": st, "exists": bool(r),
                    "version": r["version"] if r else None, "total": int(r["total"] or 0) if r else 0,
                    "done": int(r["done"] or 0) if r else 0, "minutes": minutes.get(ds, 0),
                    "kinds": blocks.get(ds, []), "week": week_index(d) if d >= start_date() else None,
                    "test": {"score": tests[ds]["score"], "max": tests[ds]["max"]} if ds in tests else None,
                    "stuck": stuck.get(ds, 0)})
        d += timedelta(days=1)
    from . import tracks
    pr = tracks.projection()
    return {"month": month, "today": today().isoformat(), "start": start_date().isoformat(), "days": out,
            "deadline": pr.get("deadline"), "end": pr.get("projected_end"),
            "exams": _exams() if plan.key() == "custom" else {}}


def _exams() -> dict[str, str]:
    """Exam day → the courses examined on it ("Calculus, Algebra")."""
    out: dict[str, list[str]] = {}
    for t in plan.tracks():
        if t.get("deadline"):
            out.setdefault(t["deadline"], []).append(t["label"])
    return {d: ", ".join(v) for d, v in out.items()}


# ---------------------------------------------------------------- tracks
def _khan_track() -> list[dict]:
    scores: dict[str, list[dict]] = {}
    for s in db.q("SELECT item, date, value, passed FROM scores WHERE kind='khan_unit' ORDER BY id"):
        scores.setdefault(s["item"], []).append(s)
    cur = db.kv_get("cursor", {}).get("khan_unit", 0)
    out = []
    for i, u in enumerate(KHAN_UNITS):
        name = u["name"] if u["course"] == "Algebra 1" else f"{u['course']} · {u['name']}"
        tries = scores.get(khan_item(i), [])
        best = max((t["value"] for t in tries), default=None)
        passed = any(t["passed"] for t in tries)
        st = "passed" if passed else "current" if i == cur else "tried" if tries else "todo"
        out.append({"idx": i, "name": name, "status": st, "best": best, "tries": len(tries)})
    return out


def _beej_track() -> list[dict]:
    per: dict[int, list[str]] = {}
    for t in db.q("SELECT title, kind, status, meta FROM tasks WHERE block_id IN (SELECT id FROM blocks WHERE kind='c')"):
        chs = set()
        ch = _meta(t).get("chapter")
        if ch:
            chs.add(int(ch))
        if t["kind"] == "read":
            chs |= {int(x) for x in re.findall(r"Beej (\d+)", t["title"])}
        for c in chs:
            per.setdefault(c, []).append(t["status"])
    quiz = {}
    for s in db.q("SELECT item, value, max, passed FROM scores WHERE kind='c_quiz' ORDER BY id"):
        quiz[s["item"]] = s
    out = []
    for n, title, _ in BEEJ_CHAPTERS:
        sts = per.get(n, [])
        done = sum(1 for s in sts if s == "done")
        st = "todo" if not sts else "done" if done == len(sts) else "doing" if done or "doing" in sts else "planned"
        out.append({"n": n, "title": title, "status": st, "tasks": len(sts), "done": done})
    return out


def _kintsugi_track() -> list[dict]:
    tasks = db.q("SELECT title, status, resources, files, meta FROM tasks "
                 "WHERE block_id IN (SELECT id FROM blocks WHERE kind='kintsugi')")
    out = []
    for i, group in enumerate(KINTSUGI_ORDER):
        stem = group[0].split("/")[-1].rsplit(".", 1)[0]
        mine = []
        for t in tasks:
            meta = _meta(t)
            res = json.loads(t["resources"]) if isinstance(t["resources"], str) else t["resources"]
            files = json.loads(t["files"]) if isinstance(t["files"], str) else t["files"]
            paths = {r.get("path") for r in res if r.get("kind") == "kintsugi"}
            if meta.get("kintsugi_idx") == i or paths & set(group) or f"cpp/kintsugi/{stem}.md" in files:
                mine.append(t["status"])
        done = sum(1 for s in mine if s == "done")
        st = "todo" if not mine else "done" if done == len(mine) else "doing" if done or "doing" in mine else "planned"
        out.append({"idx": i, "name": stem, "files": group, "status": st, "tasks": len(mine), "done": done})
    return out


# ---------------------------------------------------------------- progress
def progress() -> dict:
    scores = db.q("SELECT id, ts, date, kind, item, value, max, threshold, passed FROM scores ORDER BY ts")
    tests = db.q("SELECT id, date, kind, score, max, source FROM tests WHERE status='submitted' AND kind<>'practice' ORDER BY date, id")
    # stuck points per week: opened, resolved, by source
    weeks: dict[int, dict] = {}
    for s in db.q("SELECT date, source, resolved FROM stuck"):
        w = week_index(date.fromisoformat(s["date"]))
        e = weeks.setdefault(w, {"week": w, "opened": 0, "resolved": 0, "sources": {}})
        e["opened"] += 1
        e["resolved"] += int(bool(s["resolved"]))
        e["sources"][s["source"]] = e["sources"].get(s["source"], 0) + 1
    cur_w = max(week_index(today()), 0)
    stuck_weeks = [weeks.get(w, {"week": w, "opened": 0, "resolved": 0, "sources": {}}) for w in range(0, cur_w + 1)]
    open_now = db.q1("SELECT COUNT(*) AS n FROM stuck WHERE resolved=0")["n"]

    thresholds = []
    for k, v in plan.thresholds().items():
        rows = [s for s in scores if s["kind"] == k]
        last = rows[-1] if rows else None
        thresholds.append({"key": k, "label": v["label"], "threshold": v["threshold"], "max": v.get("max", 100),
                           "unit": v.get("unit", ""), "count": len(rows),
                           "last": last["value"] if last else None,
                           "passed": sum(1 for r in rows if r["passed"]), "failed": sum(1 for r in rows if r["passed"] == 0)})
    base = {"scores": scores, "tests": tests, "stuck_weeks": stuck_weeks, "stuck_open": open_now, "thresholds": thresholds,
            "topics": topics()}
    if not plan.is_ctu():
        from . import tracks
        return {"khan": [], "beej": [], "kintsugi": [], "tracks": tracks.progress(), **base}
    thresholds.append({"key": "ielts_essay", "label": "IELTS essay (Task 2)", "threshold": 6.0, "max": 9, "unit": "band",
                       "count": 0, "last": None, "passed": 0, "failed": 0, "note": "6.0 by end of Phase 1, 6.5 by Oct 2028"})
    return {"khan": _khan_track(), "beej": _beej_track(), "kintsugi": _kintsugi_track(), "tracks": [], **base}


def _topic_key(t: str) -> str:
    return " ".join((t or "").lower().split())


def topics(limit: int = 12) -> list[dict]:
    """Every finished test's answers grouped by topic, weakest first: how often right, the last few attempts (is it
    getting better?), the last miss as an example, and the open sticking points on it."""
    out: dict[str, dict] = {}
    for t in db.q("SELECT id, date, kind, questions, results FROM tests WHERE status='submitted' AND cancelled=0 "
                  "AND results IS NOT NULL ORDER BY date, id"):
        qs = {q["id"]: q for q in json.loads(t["questions"] or "[]")}
        per: dict[str, list[int]] = {}
        for r in json.loads(t["results"] or "[]"):
            name = (r.get("topic") or "").strip()
            if not name or r.get("void"):
                continue
            e = out.setdefault(_topic_key(name), {"topic": name, "right": 0, "total": 0, "attempts": [], "miss": None,
                                                 "stuck_open": 0})
            e["right"] += int(bool(r["correct"]))
            e["total"] += 1
            per.setdefault(_topic_key(name), [0, 0])
            per[_topic_key(name)][0] += int(bool(r["correct"]))
            per[_topic_key(name)][1] += 1
            if not r["correct"]:
                q = qs.get(r["id"]) or {}
                e["miss"] = {"date": t["date"], "test_id": t["id"], "prompt": " ".join(x for x in (q.get("prompt", ""), q.get("math", "")) if x)[:240],
                             "given": r.get("given", ""), "answer": r.get("answer", "")}
        for k, (ok, n) in per.items():
            out[k]["attempts"].append({"date": t["date"], "test_id": t["id"], "kind": t["kind"], "right": ok, "total": n})
    for s in db.q("SELECT summary FROM stuck WHERE resolved=0"):
        for k, e in out.items():
            if k and k in _topic_key(s["summary"]):
                e["stuck_open"] += 1
    rows = list(out.values())
    for e in rows:
        e["attempts"] = e["attempts"][-5:]
        a = e["attempts"]
        e["trend"] = (None if len(a) < 2 else "up" if a[-1]["right"] / a[-1]["total"] > a[0]["right"] / a[0]["total"]
                      else "down" if a[-1]["right"] / a[-1]["total"] < a[0]["right"] / a[0]["total"] else "flat")
    rows.sort(key=lambda e: (e["right"] / e["total"], -e["total"]))
    from . import notes
    for e in rows[:limit]:
        e["notes"] = [{"id": n["id"], "title": n["title"]} for n in notes.about(e["topic"])[:3]]
    return rows[:limit]


# ---------------------------------------------------------------- history feed
EV_TYPES = ("done", "compile_ok", "compile_fail", "score", "test_submitted", "day_closed", "start")


def history(days: int = 30, before: str | None = None) -> dict:
    """Commit-log style feed grouped by day, newest first. Compile events are folded per file."""
    end = date.fromisoformat(before) if before else today() + timedelta(days=1)
    start = end - timedelta(days=days)
    titles = {r["id"]: r["title"] for r in db.q("SELECT id, title FROM tasks WHERE date>=? AND date<?",
                                                  (start.isoformat(), end.isoformat()))}
    items: list[dict] = []
    compiles: dict[tuple, dict] = {}
    for e in db.q(f"SELECT ts, date, task_id, type, data FROM events WHERE date>=? AND date<? AND type IN "
                  f"({','.join('?' * len(EV_TYPES))}) ORDER BY ts", (start.isoformat(), end.isoformat(), *EV_TYPES)):
        data = json.loads(e["data"] or "{}")
        title = titles.get(e["task_id"], "")
        if e["type"] in ("compile_ok", "compile_fail"):
            key = (e["date"], data.get("file"))
            c = compiles.setdefault(key, {"ts": e["ts"], "date": e["date"], "kind": "compile", "file": data.get("file"),
                                          "ok": 0, "fail": 0})
            c["ts"] = e["ts"]
            c["ok" if e["type"] == "compile_ok" else "fail"] += 1
            c["last_ok"] = e["type"] == "compile_ok"
            continue
        if e["type"] == "start":
            continue  # starts are noise in a log; done carries the time
        item = {"ts": e["ts"], "date": e["date"], "kind": e["type"], "title": title}
        if e["type"] == "done":
            item["spent_min"] = round((data.get("spent_sec") or 0) / 60)
        elif e["type"] == "score":
            item.update(unit=data.get("unit"), percent=data.get("percent"), passed=data.get("passed"))
        elif e["type"] == "test_submitted":
            item.update(test_id=data.get("test_id"), score=data.get("score"), max=data.get("max"))
        elif e["type"] == "day_closed":
            item["auto"] = data.get("auto")
        items.append(item)
    for c in compiles.values():
        items.append({"ts": c["ts"], "date": c["date"], "kind": "compile", "title": c["file"], "ok": c["ok"],
                      "fail": c["fail"], "last_ok": c.get("last_ok", False)})
    for s in db.q("SELECT ts, date, source, summary, resolved FROM stuck WHERE date>=? AND date<?",
                  (start.isoformat(), end.isoformat())):
        items.append({"ts": s["ts"], "date": s["date"], "kind": "stuck", "title": s["summary"], "source": s["source"],
                      "resolved": bool(s["resolved"])})
    for c in git_log():
        if start.isoformat() <= c["date"] < end.isoformat():
            items.append({"ts": c["ts"], "date": c["date"], "kind": "commit", "title": c["message"], "hash": c["short"],
                          "files": c["files"], "add": c["add"], "del": c["del"]})
    items.sort(key=lambda x: x["ts"], reverse=True)
    grouped: dict[str, list] = {}
    for it in items:
        grouped.setdefault(it["date"], []).append(it)
    minutes = _minutes_by_day()
    out = [{"date": d, "weekday": WEEKDAY_TR_SHORT[date.fromisoformat(d).weekday()], "minutes": minutes.get(d, 0),
            "items": v} for d, v in sorted(grouped.items(), reverse=True)]
    oldest = min([c["date"] for c in git_log()] + [start_date().isoformat()])
    return {"days": out, "next_before": start.isoformat() if start.isoformat() > oldest else None}


# ---------------------------------------------------------------- profile
_gh_cache: dict = {"at": 0.0, "user": None}
_MONTHS = {"Oca": 1, "Şub": 2, "Mar": 3, "Nis": 4, "May": 5, "Haz": 6, "Tem": 7, "Ağu": 8, "Eyl": 9, "Eki": 10,
           "Kas": 11, "Ara": 12}


def github_user() -> dict | None:
    """Local `gh api user`, cached for 6 hours. Returns None when gh is missing or logged out."""
    if time.time() - _gh_cache["at"] < 6 * 3600:
        return _gh_cache["user"]
    user = None
    try:
        r = subprocess.run(["gh", "api", "user"], capture_output=True, text=True, timeout=8)
        if r.returncode == 0:
            j = json.loads(r.stdout)
            user = {k: j.get(k) for k in ("login", "name", "avatar_url", "html_url", "public_repos", "created_at")}
    except Exception:
        pass
    _gh_cache.update(at=time.time(), user=user)
    return user


_MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# COACH.md stays Turkish (it is the coach's file); these are display translations.
# Anything not listed here is shown as written.
_ROADMAP_EN = {
    "Kintsugi okuma disk_manager→buffer_pool→serializer→btree_node": "Kintsugi reading disk_manager→buffer_pool→serializer→btree_node",
    "essay/hafta": "essay/week",
    "Ara ortası USACO Bronze (C++)": "USACO Bronze (C++) mid-December",
    "ilk SCIO (Algebra 2 sonrası)": "first SCIO (after Algebra 2)",
    "C dinamik dizi/bağlı liste/stack/queue": "C dynamic array/linked list/stack/queue",
    "Kintsugi okuma bitiş (wal, store, main) → yeniden yazım page I/O + buffer pool":
        "Kintsugi reading done (wal, store, main) → rewrite page I/O + buffer pool",
    "Şubat 18.06 başlar": "18.06 starts in February",
    "18.06 (psets + 3 sınav)": "18.06 (psets + 3 exams)",
    "USACO Bronze bitir → Silver": "finish USACO Bronze → Silver",
    "Kintsugi B+tree + WAL yeniden yazım bitti": "Kintsugi B+tree + WAL rewrite done",
    "mezuniyet + apostil": "graduation + apostille",
    "Stat 110 başlar": "Stat 110 starts",
    "fizik (mekanik) başlar": "physics (mechanics) starts",
    "fizik → Indium fizik+ECS yeniden yazım": "physics → Indium physics+ECS rewrite",
    "6.006 ilk yarı C++": "6.006 first half in C++",
    "SCIO her 2 ayda": "SCIO every 2 months",
}


def _plan_roadmap() -> list[dict]:
    """A custom plan's milestones (drafted with the plan, approved with it)."""
    out = []
    t = today()
    for r in plan.active().get("roadmap") or []:
        try:
            a = date.fromisoformat(r["start"] + "-01")
            b0 = date.fromisoformat(r["end"] + "-01")
        except (KeyError, ValueError):
            continue
        end_m = date(b0.year + (b0.month == 12), b0.month % 12 + 1, 1) - timedelta(days=1)
        yy = f"{b0.year % 100:02d}"
        label = (f"{_MON_EN[a.month - 1]} {yy}" if (a.year, a.month) == (b0.year, b0.month)
                 else f"{_MON_EN[a.month - 1]}–{_MON_EN[b0.month - 1]} {yy}")
        out.append({"label": label, "start": a.isoformat(), "end": end_m.isoformat(),
                    "items": [str(x) for x in r.get("items") or []][:8], "current": a <= t <= end_m})
    return out


def roadmap() -> list[dict]:
    if not plan.is_ctu():
        return _plan_roadmap()
    try:
        text = COACH_MD.read_text()
    except OSError:
        return []
    sec = text.split("## 1 yıllık yol haritası", 1)
    if len(sec) < 2:
        return []
    body = sec[1].split("\n## ", 1)[0]
    out = []
    t = today()
    for line in body.splitlines():
        m = re.match(r"- (.+?) (\d{2})(?: \(.*?\))?: (.+)", line.strip())
        if not m:
            continue
        label, yy, rest = m.group(1), int(m.group(2)), m.group(3)
        months = [_MONTHS.get(x.strip()[:3]) for x in re.split(r"[–-]", label)]
        months = [x for x in months if x]
        if not months:
            continue
        y = 2000 + yy
        a, b = months[0], months[-1]
        start = date(y if a <= b else y - 1, a, 1)
        end_m = date(y + (b == 12), b % 12 + 1, 1) - timedelta(days=1)
        items = [x.strip().rstrip(".") for x in rest.split(";") if x.strip()]
        items = [_ROADMAP_EN.get(x, x) for x in items]
        en = _MON_EN[a - 1] if a == b else f"{_MON_EN[a - 1]}–{_MON_EN[b - 1]}"
        out.append({"label": f"{en} {yy}", "start": start.isoformat(), "end": end_m.isoformat(), "items": items,
                    "current": start <= t <= end_m or (t < start_date() and start <= start_date() <= end_m)})
    return out


def goals() -> list[dict]:
    """User-edited goals (kv 'goals') or the defaults. Display only: thresholds live in the plan (profile.thresholds())."""
    return db.kv_get("goals", None) or plan.goals()


def profile() -> dict:
    minutes = _minutes_by_day()
    cur, best = _streaks(minutes)
    closed = db.q1("SELECT COUNT(*) AS n FROM days WHERE status='closed'")["n"]
    done = db.q1("SELECT COUNT(*) AS n FROM tasks WHERE status='done'")["n"]
    tests = db.q1("SELECT COUNT(*) AS n, COALESCE(SUM(score),0) AS s, COALESCE(SUM(max),0) AS m FROM tests "
                  "WHERE status='submitted' AND kind<>'practice'")
    commits = [c for c in git_log() if c["date"] >= start_date().isoformat()]
    me = account.get()
    # GitHub is shown only when the user chose it; otherwise it is offered when the gh CLI is logged in
    gh = github_user()
    return {
        "me": me,
        "github": gh if me["github"] == "on" else None,
        "github_offer": {"login": gh["login"]} if gh and me["github"] != "on" else None,
        "goals": goals(),
        "week": week_index(today()), "start": start_date().isoformat(), "today": today().isoformat(),
        "totals": {"minutes": sum(minutes.values()), "closed_days": closed, "tasks_done": done,
                   "tests": tests["n"], "test_correct": tests["s"], "test_total": tests["m"],
                   "commits": len(commits), "streak": cur, "best_streak": best},
        "roadmap": roadmap(),
        "thresholds": plan.thresholds(),
    }


def _week_minutes() -> int:
    """Planned study minutes in a week of the active plan (breaks left out)."""
    return sum(_block_min(b) for wd in plan.study_weekdays() for b in plan.week(wd) if b["kind"] != "break")


def _track_summary() -> list[dict]:
    from . import tracks
    out = []
    for tr in tracks.progress():
        units = tr["units"]
        cur = next((u for u in units if u["status"] in ("current", "tried")), None)
        out.append({"key": tr["key"], "label": tr["label"], "passed": sum(1 for u in units if u["status"] == "passed"),
                    "total": len(units), "current": cur["name"] if cur else None})
    return out


def dashboard() -> dict:
    minutes = _minutes_by_day()
    cur, best = _streaks(minutes)
    ctu = plan.is_ctu()
    khan = _khan_track() if ctu else []
    beej = _beej_track() if ctu else []
    t = today()
    wk_start = week_start() + timedelta(days=7 * max(week_index(t), 0))
    week_min = sum(minutes.get((wk_start + timedelta(days=i)).isoformat(), 0) for i in range(7))
    stuck = db.q("SELECT id, ts, date, task_id, source, summary, detail, resolved FROM stuck WHERE resolved=0 "
                 "ORDER BY ts DESC LIMIT 8")
    return {
        "streak": cur, "best_streak": best, "week": week_index(t), "week_minutes": week_min,
        "week_target_min": 47 * 60 if ctu else _week_minutes(),
        "khan_passed": sum(1 for k in khan if k["status"] == "passed"), "khan_total": len(khan),
        "khan_current": next((k for k in khan if k["status"] in ("current", "tried")), None),
        "beej_done": sum(1 for b in beej if b["status"] == "done"), "beej_total": len(beej),
        "tracks": [] if ctu else _track_summary(),
        "stuck": stuck,
        "last_test": db.q1("SELECT id, date, score, max FROM tests WHERE kind='eod' AND status='submitted' "
                           "ORDER BY date DESC, id DESC LIMIT 1"),
        "week_days": _week_days(wk_start, minutes),
        "exams": _upcoming_exams(t),
    }


def _week_days(start: date, minutes: dict[str, int]) -> list[dict]:
    """The seven days of this week: minutes studied and minutes planned (the day's tasks once it is written, the
    plan's blocks for that weekday before), and whether it is a study day."""
    est = {r["date"]: r["m"] for r in db.q(
        "SELECT date, SUM(est_min) AS m FROM tasks WHERE date BETWEEN ? AND ? GROUP BY date",
        (start.isoformat(), (start + timedelta(days=6)).isoformat()))}
    out = []
    for i in range(7):
        d = start + timedelta(days=i)
        ds = d.isoformat()
        study = _is_study(d)
        if ds in est:
            planned = int(est[ds] or 0)
        elif study:
            planned = sum(_block_min(b) for b in plan.week(d.weekday()) if b["kind"] != "break")
        else:
            planned = 0
        out.append({"date": ds, "minutes": minutes.get(ds, 0), "planned": planned, "study": study})
    return out


def _block_min(b: dict) -> int:
    h1, m1 = map(int, b["start"].split(":"))
    h2, m2 = map(int, b["end"].split(":"))
    return max(0, h2 * 60 + m2 - h1 * 60 - m1)


def _upcoming_exams(t: date) -> list[dict]:
    """Exam dates of the plan's tracks from today on, nearest first."""
    out = []
    for tr in plan.tracks():
        try:
            d = date.fromisoformat(tr.get("deadline") or "")
        except ValueError:
            continue
        if d >= t:
            out.append({"key": tr["key"], "label": tr.get("label") or tr["key"], "date": d.isoformat(), "days": (d - t).days})
    return sorted(out, key=lambda e: e["date"])

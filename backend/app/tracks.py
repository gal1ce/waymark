"""The planner of a custom plan (profile engine 'tracks'): the plan names a few tracks (a course, a book, a topic list),
each an ordered list of units, and the weekly template says which block belongs to which track. Every block of a
track works on the track's next unit: study it, then work problems; the last session of a unit ends with a short
closed-book unit check, and a unit whose check is below the pass mark is studied again and retaken before the track
moves on. With an API key the model then shapes the day from the user's results, inside the same rules.

The cursor (kv 'track_cursor') says where each track is: {track key: {"unit": i, "session": s}}. A unit the user took
out of the plan ("skip": true on the unit) is stepped over wherever the cursor walks; it keeps its place in the list,
so unit numbers, scores and the tasks already done stay as they were and putting it back is one flag. "done" on a
position lists units after it that were worked through already (a unit put back behind the cursor is studied next,
then the track goes on past them)."""
from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta

from . import db, health, llm, profile, prompts
from .config import WEEKDAY_TR, has_api_key, today, week_index
from .seed import T

log = logging.getLogger("ctu.tracks")

KINDS = ("read", "practice", "review", "unit_quiz", "write", "other")
QUIZ_MIN = 20          # minutes of a unit check
END_TEST_MIN = 30      # the end-of-day test's time limit (tests_eod); its task fills the rest of the test block
RUNWAY_WARN_UNITS = 2  # a track with this many units left asks for more


def _minutes(b: dict) -> int:
    h1, m1 = map(int, b["start"].split(":"))
    h2, m2 = map(int, b["end"].split(":"))
    return max(0, (h2 * 60 + m2) - (h1 * 60 + m1))


def slots(blocks: list[dict]) -> list[tuple[dict, str]]:
    """Each block with the key its tasks are stored under in a plan: the block kind, then kind2, kind3 … for the
    second and later blocks of the same kind on a day (the CTU plan's math/math2 follow the same rule)."""
    seen: dict[str, int] = {}
    out = []
    for b in blocks:
        n = seen[b["kind"]] = seen.get(b["kind"], 0) + 1
        out.append((b, b["kind"] if n == 1 else f"{b['kind']}{n}"))
    return out


EXAM_CRUNCH_DAYS = 7    # in the last week before a track's exam, its unfinished units take other tracks' blocks
EXAM_FAR_DAYS = 21      # ... but only from a track whose own exam is further away than this (or has none)


def exam_dates(tracks_: list[dict]) -> dict[str, date]:
    out = {}
    for tr in tracks_:
        try:
            if tr.get("deadline"):
                out[tr["key"]] = date.fromisoformat(tr["deadline"])
        except ValueError:
            pass
    return out


def removed(unit: dict | None) -> bool:
    """True for a unit the user took out of the plan."""
    return bool((unit or {}).get("skip"))


def is_removed(tr: dict | None, idx) -> bool:
    units = (tr or {}).get("units") or []
    return isinstance(idx, int) and 0 <= idx < len(units) and removed(units[idx])


def settle(units: list[dict], pos: dict) -> dict:
    """Moves a position past the units the user took out and the ones listed as already done. Changes pos."""
    done = pos.get("done") or []
    while pos["unit"] < len(units) and (removed(units[pos["unit"]]) or pos["unit"] in done):
        pos["unit"], pos["session"] = pos["unit"] + 1, 0
    if "done" in pos:
        rest = [i for i in done if i > pos["unit"]]
        if rest:
            pos["done"] = rest
        else:
            pos.pop("done")
    return pos


def ahead(units: list[dict], pos: dict) -> list[int]:
    """The units still to study from a (settled) position, in order."""
    done = pos.get("done") or []
    return [i for i in range(pos["unit"], len(units)) if not removed(units[i]) and i not in done]


def sessions_left(tracks_: list[dict], cur: dict) -> dict[str, int]:
    out = {}
    for tr in tracks_:
        units = tr.get("units") or []
        pos = settle(units, dict(cur.get(tr["key"]) or {"unit": 0, "session": 0}))
        out[tr["key"]] = max(0, sum(_sessions(units[i]) for i in ahead(units, pos)) - (pos["session"] if pos["unit"] < len(units) else 0))
    return out


def remap(blocks: list[dict], d: date, tracks_: list[dict], left: dict[str, int]) -> list[dict]:
    """Per-course exam dates decide who gets a block on day d:
    - a track whose exam is over gives its blocks to the track with the nearest exam still ahead;
    - in the week before a track's exam, while it still has sessions left, it takes the blocks of tracks whose own
      exam is more than three weeks away (or have none).
    A moved block keeps its time and says where it came from (moved_from). With no exam dates nothing changes."""
    dl = exam_dates(tracks_)
    if not dl:
        return blocks
    labels = {tr["key"]: tr["label"] for tr in tracks_}
    ahead = [k for k, v in sorted(dl.items(), key=lambda kv: kv[1]) if v >= d]
    out = []
    for b in blocks:
        a, to, why = b.get("kind"), None, ""
        if a in labels:
            if a in dl and dl[a] < d:
                to, why = (ahead[0] if ahead else None), "over"
            else:
                crunch = [k for k in ahead if k != a and (dl[k] - d).days <= EXAM_CRUNCH_DAYS and left.get(k, 0) > 0]
                if crunch and (a not in dl or (dl[a] - d).days > EXAM_FAR_DAYS):
                    to, why = crunch[0], "crunch"
        out.append({**b, "kind": to, "title": labels[to], "moved_from": a, "moved_why": why} if to and to != a else b)
    return out


def _moved(b: dict, tr: dict) -> dict:
    """Task meta saying why the block went to this track (for "Why this plan?")."""
    if not b.get("moved_from"):
        return {}
    src = profile.track(b["moved_from"])
    return {"moved_from": src["label"] if src else b["moved_from"], "moved_why": b.get("moved_why", ""),
            "exam": tr.get("deadline", "")}


def day_blocks(d: date, cur: dict | None = None) -> list[dict]:
    """The approved schedule's blocks for day d, after the exam dates had their say (see remap)."""
    blocks = profile.day_week(d)
    if profile.key() != "custom":
        return blocks
    trs = profile.tracks()
    # a day already stored keeps its blocks: planning it again must not move them under its tasks
    stored = [dict(b) for b in db.q("SELECT start, end, kind, title FROM blocks WHERE date=? ORDER BY ord", (d.isoformat(),))]
    if stored and all(b["kind"] in ("break", "test") or profile.track(b["kind"]) for b in stored):
        return stored
    return remap(blocks, d, trs, sessions_left(trs, cur if cur is not None else cursor()))


def track_slots(d: date, cur: dict | None = None) -> list[tuple[dict, str, dict]]:
    out = []
    for b, key in slots(day_blocks(d, cur)):
        tr = profile.track(b["kind"])
        if tr:
            out.append((b, key, tr))
    return out


def cursor() -> dict:
    cur = db.kv_get("track_cursor", None) or {}
    for tr in profile.tracks():
        cur.setdefault(tr["key"], {"unit": 0, "session": 0})
    return cur


def _sessions(unit: dict) -> int:
    try:
        return max(1, min(6, int(unit.get("sessions") or 1)))
    except (TypeError, ValueError):
        return 1


def item(tr: dict, idx: int) -> str:
    """The name a unit check's score is stored under, e.g. 'Real analysis · Sequences'."""
    units = tr.get("units") or []
    name = units[idx]["title"] if 0 <= idx < len(units) else f"unit {idx + 1}"
    return f"{tr['label']} · {name}"


def _resources(unit: dict) -> list[dict]:
    return _clean([r for r in unit.get("resources") or []])


def _clean(rs: list[dict]) -> list[dict]:
    """Links (https only) and named sources without a link ('Abbott, ch. 2'), shown as a plain reference."""
    out = []
    for r in rs[:6]:
        href, label = (r.get("href") or "").strip(), " ".join(str(r.get("label") or "").split())[:120]
        if re.match(r"https://[^\s/]+\S*$", href):
            out.append({"label": label or href, "kind": "url", "href": href})
        elif label:
            out.append({"label": label, "kind": "ref"})
    return out


def _keep_sources(got: list[dict], unit: dict | None) -> list[dict]:
    """The sources the approved plan gave a unit always stay on its tasks, first. The day's model may add a link,
    but a name it made up without one ('Calculus Chapter 1') never replaces a real source."""
    planned = _resources(unit) if unit else []
    if not planned:
        return got
    seen = {r.get("href") or r["label"].casefold() for r in planned}
    extra = [r for r in got if r["kind"] == "url" and r["href"] not in seen]
    return (planned + extra)[:6]


def _failed_unit(tr: dict, upto: int) -> int | None:
    """The last unit before `upto` whose newest unit check is below the pass mark and has no retake planned yet."""
    for idx in range(upto - 1, -1, -1):
        if is_removed(tr, idx):
            continue   # taken out of the plan: no retake
        last = db.q1("SELECT passed FROM scores WHERE kind='unit_quiz' AND item=? ORDER BY id DESC LIMIT 1",
                     (item(tr, idx),))
        if last is None:
            continue
        if last["passed"]:
            return None
        # a check that is still to be taken (no score on it yet) is the retake
        planned = db.q1("SELECT 1 FROM tasks t WHERE t.kind='unit_quiz' AND json_extract(t.meta, '$.item')=? AND NOT "
                        "EXISTS (SELECT 1 FROM scores s WHERE s.task_id=t.id) LIMIT 1", (item(tr, idx),))
        return None if planned else idx
    return None


def retake_tasks(tr: dict, idx: int, minutes: int) -> list[dict]:
    unit = tr["units"][idx]
    study = max(15, min(minutes - QUIZ_MIN, 60))
    return [T(f"{unit['title']} · study again", "review", study,
              "The unit check was below the pass mark. Go back to what you got wrong (it is in the check's results "
              "and your sticking points), redo those problems, then retake the check.",
              _resources(unit), meta={"track": tr["key"], "unit": idx, "review_unit": idx}),
            _quiz_task(tr, idx, retake=True)]


def _quiz_task(tr: dict, idx: int, retake: bool = False) -> dict:
    unit = tr["units"][idx]
    thr = profile.thresholds().get("unit_quiz", {})
    mark = f"{thr.get('threshold', 4)}/{thr.get('max', 5)}"
    return T(f"{unit['title']} · unit check" + (" (retake)" if retake else ""), "unit_quiz", QUIZ_MIN,
             f"Closed book, 5 questions on this unit. **{mark}** to pass; below that the unit is studied again and the "
             "check is retaken before the track moves on.", learning=0,
             meta={"track": tr["key"], "unit": idx, "item": item(tr, idx)})


def _block_tasks(tr: dict, minutes: int, pos: dict) -> list[dict]:
    units = tr.get("units") or []
    settle(units, pos)
    tasks: list[dict] = []
    left = minutes
    failed = _failed_unit(tr, pos["unit"]) if pos.get("retake_checked") is None else None
    if failed is not None:
        pos["retake_checked"] = True   # one retake per track per day being built
        tasks += retake_tasks(tr, failed, left)
        left -= sum(t["est_min"] for t in tasks)
        if left < 30:
            return tasks
    if pos["unit"] >= len(units):
        kept = [i for i, u in enumerate(units) if not removed(u)]
        if not kept:
            return tasks
        n = pos.get("review", 0)
        unit = units[kept[n % len(kept)]]
        tasks.append(T(f"{unit['title']} · review", "review", left,
                       (f"Every unit of this track is done; these blocks are review until its exam on {tr['deadline']}. "
                        "Redo the hardest problems of this unit from memory under exam conditions, then check them "
                        "against the source, and clear its open sticking points." if tr.get("deadline") else
                        "This track has no new units left. Redo the hardest problems of this unit from memory, then "
                        "check them against the source. Ask the coach to add the next units to the plan."),
                       _resources(unit), meta={"track": tr["key"], "unit": kept[n % len(kept)], "track_review": n + 1,
                             **({"exam": tr["deadline"]} if tr.get("deadline") else {})}))
        pos["review"] = n + 1
        return tasks
    unit = units[pos["unit"]]
    total = _sessions(unit)
    s = pos["session"]
    last = s == total - 1
    quiz = QUIZ_MIN if last else 0
    body = left - quiz
    study = max(15, round(body * 0.5 / 5) * 5)
    practice = max(10, body - study)
    part = f" ({s + 1}/{total})" if total > 1 else ""
    meta = {"track": tr["key"], "unit": pos["unit"], "session": s}
    tasks += [T(f"{unit['title']} · study{part}", "read", study,
                (unit.get("objective") or "").strip() + "\n\nWork through the sources below with pen and paper: "
                "redo every worked example yourself before reading its solution.", _resources(unit), meta=meta),
              T(f"{unit['title']} · problems{part}", "practice", practice,
                (unit.get("practice") or "Problems from the unit's sources, easiest first.").strip() +
                "\n\nWrite full solutions. Where you get stuck for more than a few minutes, note exactly where and "
                "move on; the coach helps after 30 minutes. No copy of the source? Press **Practice set**: the app writes "
                "problems of the same kind, checks your answers and keeps the ones you miss as sticking points.",
                _resources(unit), meta=meta)]
    if last:
        tasks.append(_quiz_task(tr, pos["unit"]))
        pos["unit"], pos["session"] = pos["unit"] + 1, 0
        settle(units, pos)
    else:
        pos["session"] = s + 1
    return tasks


def _end_tasks(minutes: int = END_TEST_MIN) -> list[dict]:
    """The test block's tasks. They fill the block, so the day adds up to the net time the plan promised."""
    close = 5 if profile.has("repo") else 0
    est = max(15, minutes - close)
    rest = "; the rest of the block goes to reading the results." if est > END_TEST_MIN else "."
    out = [T("End-of-day test", "test", est, "From today's topics and your sticking points. "
             f"Closed book, {END_TEST_MIN} min{rest}", learning=0)]
    if close:
        out.append(T("Close the day + commit", "other", 5, "The app writes the day's record to `PROGRESS.md`. "
                     "You commit your work.", [{"label": "PROGRESS.md", "kind": "repo", "path": "PROGRESS.md"}],
                     learning=0))
    return out


def template_day(d: date, cur: dict | None = None) -> dict:
    """The day's tasks from the cursor (not saved; advance() moves the cursor once the day is stored)."""
    cur = json.loads(json.dumps(cur if cur is not None else cursor()))
    plan: dict = {}
    for b, key, tr in track_slots(d, cur):
        plan[key] = _block_tasks(tr, _minutes(b), cur[tr["key"]])
        for t in plan[key]:
            t["meta"] |= _moved(b, tr)
    for b, key in slots(profile.day_week(d)):
        if b["kind"] == "test":
            plan[key] = _end_tasks(_minutes(b))
    return plan


def advance(d: date, plan: dict) -> None:
    """Move each track past what the stored day covers: one session per block that studies the track's current
    unit, and on to the next unit once its unit check is planned (or its sessions are used up)."""
    cur = cursor()
    for _b, key, tr in track_slots(d):
        pos = cur[tr["key"]]
        units = tr.get("units") or []
        settle(units, pos)
        tasks = [t for t in plan.get(key, []) if (t.get("meta") or {}).get("track") == tr["key"]]
        for t in tasks:
            if t["meta"].get("track_review"):
                pos["review"] = max(pos.get("review", 0), int(t["meta"]["track_review"]))
        if pos["unit"] >= len(units):
            continue
        here = [t for t in tasks if t["meta"].get("unit") == pos["unit"]]
        if any(t["kind"] == "unit_quiz" for t in here):
            pos["unit"], pos["session"] = pos["unit"] + 1, 0
        elif any(t["kind"] in ("read", "practice") for t in here):
            pos["session"] += 1
            if pos["session"] >= _sessions(units[pos["unit"]]):   # the check was left out: the unit still ends
                pos["unit"], pos["session"] = pos["unit"] + 1, 0
        settle(units, pos)
    db.kv_set("track_cursor", cur)


HORIZON_DAYS = 3 * 366   # a projection stops looking after this


def finish(week: list[list[dict]], tracks_: list[dict], start: date, cur: dict | None = None) -> date | None:
    """The day the last unit of every track gets its last session, walking the weekly schedule from `start` with
    one session per block of a track (as advance() moves the cursor). Assumes every unit check passes the first time;
    a retake moves the day later. None when a track with units left never gets a block."""
    cur = {k: dict(v) for k, v in (cur or {}).items()}
    left = {k: n for k, n in sessions_left(tracks_, cur).items() if n > 0}
    if not left:
        return None
    per_week = {k: sum(1 for day in week for b in day if b.get("kind") == k) for k in left}
    if any(per_week[k] == 0 for k in left) and not exam_dates(tracks_):
        return None
    d, last = start, start
    full = sessions_left(tracks_, cur)
    for _ in range(HORIZON_DAYS):
        for b in remap(week[d.weekday()] if d.weekday() < len(week) else [], d, tracks_, full):
            if left.get(b.get("kind"), 0) > 0:
                full[b["kind"]] -= 1
                left[b["kind"]] -= 1
                last = d
        if not any(left.values()):
            return last
        d += timedelta(days=1)
    return None


def unit_ends(week: list[list[dict]], tracks_: list[dict], start: date, cur: dict | None = None) -> list[tuple[date, str, str]]:
    """(day, track label, unit title) for the last session of every unit left (from the cursor `cur`, else from the
    start), walking the schedule as finish() does."""
    cur = cur or {}
    queue = {}
    for tr in tracks_:
        units = tr.get("units") or []
        pos = settle(units, dict(cur.get(tr["key"]) or {"unit": 0, "session": 0}))
        q = [(tr["label"], units[i]["title"], _sessions(units[i])) for i in ahead(units, pos)]
        if q and pos.get("session"):
            q[0] = (q[0][0], q[0][1], max(1, q[0][2] - pos["session"]))
        queue[tr["key"]] = q
    out, d = [], start
    for _ in range(HORIZON_DAYS):
        if not any(queue.values()):
            break
        left = {k: sum(n for *_x, n in q) for k, q in queue.items()}
        for b in remap(week[d.weekday()] if d.weekday() < len(week) else [], d, tracks_, left):
            q = queue.get(b.get("kind"))
            if q:
                label, title, n = q[0]
                if n <= 1:
                    q.pop(0)
                    out.append((d, label, title))
                else:
                    q[0] = (label, title, n - 1)
        d += timedelta(days=1)
    return out


def track_ends(week: list[list[dict]], tracks_: list[dict], start: date, cur: dict | None = None) -> dict[str, str]:
    """Each track's last unit day (ISO), for showing it next to the track's exam."""
    labels = {tr["label"]: tr["key"] for tr in tracks_}
    return {labels[label]: d.isoformat() for d, label, _t in unit_ends(week, tracks_, start, cur)}


def projection() -> dict:
    """The active plan's end as it stands now: from the day after the last planned day, at the current cursor."""
    p = profile.active()
    if profile.key() != "custom" or not p.get("week"):
        return {}
    row = db.q1("SELECT MAX(date) AS d FROM days")
    nxt = date.fromisoformat(row["d"]) + timedelta(days=1) if row and row["d"] else today()
    planned_from = max(nxt, today(), date.fromisoformat(p.get("start_date") or today().isoformat()))
    end = finish(p["week"], profile.tracks(), planned_from, cursor())
    return {"projected_end": end.isoformat() if end else None, "deadline": p.get("deadline") or None,
            "end_date": p.get("end_date") or None,
            "track_ends": _planned_ends() | track_ends(p["week"], profile.tracks(), planned_from, cursor())}


def _planned_ends() -> dict[str, str]:
    """For a track whose units are all planned already: the last planned day of its units."""
    out = {}
    for tr in profile.tracks():
        kept = [i for i, u in enumerate(tr.get("units") or []) if not removed(u)]
        n = (kept[-1] + 1) if kept else 0
        row = db.q1("SELECT MAX(date) AS d FROM tasks WHERE json_extract(meta, '$.track')=? AND kind IN ('read','practice','unit_quiz') "
                    "AND json_extract(meta, '$.track_review') IS NULL AND json_extract(meta, '$.unit')=?", (tr["key"], n - 1))
        if row and row["d"]:
            out[tr["key"]] = row["d"]
    return out


OUTLINE_DAYS = 21   # how far ahead a locked day shows its outline


def outline(d: date) -> list[dict] | None:
    """What a locked day of a custom plan will work on, block by block: the track, the unit and the session, and
    whether the unit check falls on it. Task texts stay hidden until the day opens; a retake or a reshaped day can
    still change it. None when there is nothing to show (another plan, too far ahead, or not a study day)."""
    if profile.key() != "custom" or not (today() < d <= today() + timedelta(days=OUTLINE_DAYS)):
        return None
    stored = db.q("SELECT b.id, b.start, b.end, b.kind, b.title FROM blocks b WHERE b.date=? ORDER BY b.ord", (d.isoformat(),))
    out = []
    if stored:
        for b in stored:
            if b["kind"] == "break":
                continue
            tr = profile.track(b["kind"])
            metas = [(t["meta"] if isinstance(t["meta"], dict) else json.loads(t["meta"] or "{}"), t["kind"]) for t in db.q("SELECT meta, kind FROM tasks WHERE block_id=?", (b["id"],))]
            unit = next((m.get("unit") for m, _k in metas if isinstance(m.get("unit"), int)), None)
            units = (tr or {}).get("units") or []
            out.append({"start": b["start"], "end": b["end"], "kind": b["kind"], "track": tr["label"] if tr else b["title"],
                        "unit": units[unit]["title"] if unit is not None and unit < len(units) else None,
                        "check": any(k == "unit_quiz" for _m, k in metas), "review": any(k == "review" for _m, k in metas)})
        return out
    row = db.q1("SELECT MAX(date) AS d FROM days")
    day = max(date.fromisoformat(row["d"]) + timedelta(days=1) if row and row["d"] else today(), today() + timedelta(days=1),
              date.fromisoformat(profile.active().get("start_date") or today().isoformat()))
    if d < day:
        return None
    cur = {k: dict(v) for k, v in cursor().items()}
    while True:
        here = []
        for b in remap(profile.day_week(day), day, profile.tracks(), sessions_left(profile.tracks(), cur)):
            tr = profile.track(b["kind"])
            if not tr:
                if b["kind"] == "test" and day == d:
                    here.append({"start": b["start"], "end": b["end"], "kind": "test", "track": "End-of-day test",
                                 "unit": None, "check": False, "review": False})
                continue
            pos, units = cur[tr["key"]], tr.get("units") or []
            settle(units, pos)
            item = {"start": b["start"], "end": b["end"], "kind": tr["key"], "track": tr["label"], "unit": None,
                    "check": False, "review": pos["unit"] >= len(units)}
            if pos["unit"] < len(units):
                n = _sessions(units[pos["unit"]])
                item |= {"unit": units[pos["unit"]]["title"], "session": pos["session"] + 1, "sessions": n,
                         "check": pos["session"] == n - 1}
                pos["session"] += 1
                if pos["session"] >= n:
                    pos["unit"], pos["session"] = pos["unit"] + 1, 0
            here.append(item)
        if day == d:
            return here or None
        day += timedelta(days=1)


def rewind(dropped: list[dict]) -> None:
    """Work pushed past the last planned day goes back to its track's cursor, so it is planned again later."""
    cur = cursor()
    for t in dropped:
        m = json.loads(t["meta"]) if isinstance(t["meta"], str) else t["meta"]
        k, u = m.get("track"), m.get("unit")
        if k in cur and isinstance(u, int) and t["kind"] in ("read", "unit_quiz") and u < cur[k]["unit"] + 1:
            s = int(m.get("session", 0))
            if t["kind"] == "unit_quiz":
                if m.get("item") and db.q1("SELECT 1 FROM scores WHERE kind='unit_quiz' AND item=? LIMIT 1", (m["item"],)):
                    continue   # a retake: it comes back by itself while the check stays below the mark
                tr = profile.track(k)
                units = (tr or {}).get("units") or []
                s = _sessions(units[u]) - 1 if u < len(units) else 0   # the check belongs to the unit's last session
            if (u, s) < (cur[k]["unit"], cur[k]["session"]):
                cur[k] = {**cur[k], "unit": u, "session": s}
    db.kv_set("track_cursor", cur)


def put_back(tr: dict, idx: int) -> None:
    """A unit put back into the plan after the cursor went past it: it is studied next, then the track goes on where it
    was; the units already worked through in between are not studied again."""
    cur = cursor()
    pos, units = cur[tr["key"]], tr.get("units") or []
    if idx >= pos["unit"]:
        return
    done = sorted(set(pos.get("done") or []) | {j for j in range(idx + 1, pos["unit"]) if not removed(units[j])})
    cur[tr["key"]] = {**{k: v for k, v in pos.items() if k != "done"}, "unit": idx, "session": 0,
                      **({"done": done} if done else {})}
    db.kv_set("track_cursor", cur)


def carry_kinds() -> list[str]:
    return [tr["key"] for tr in profile.tracks()]


# ------------------------------------------------------------------ the model shapes the day
RES = {"type": "object", "properties": {"label": {"type": "string"}, "href": {"type": "string"}}}
TASK = {"type": "object", "properties": {
    "title": {"type": "string"}, "kind": {"type": "string", "enum": list(KINDS)},
    "est_min": {"type": "integer"}, "detail": {"type": "string"},
    "resources": {"type": "array", "items": RES}, "learning": {"type": "boolean"},
    "unit": {"type": "integer"}}}
PLAN_SCHEMA = llm.strict({"type": "object", "properties": {
    "adapt_note": {"type": "string"},
    "blocks": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string"}, "tasks": {"type": "array", "items": TASK}}}}}})


def _to_internal(t: dict, tr: dict, here: int | None = None) -> dict:
    """here: the unit the planner rules put in this block, whose sources a task without a unit number gets."""
    meta: dict = {"track": tr["key"]}
    units = tr.get("units") or []
    if isinstance(t.get("unit"), int) and 0 <= t["unit"] < len(units):
        meta["unit"] = t["unit"]
        if t["kind"] == "unit_quiz":
            meta["item"] = item(tr, t["unit"])
    res = _keep_sources(_clean(t.get("resources", [])), units[meta["unit"]] if "unit" in meta
                       else units[here] if isinstance(here, int) and 0 <= here < len(units) else None)
    kind = t["kind"] if t["kind"] in KINDS else "other"
    if kind == "unit_quiz" and "item" not in meta:
        kind = "review"   # a unit check must name its unit, or its score has nowhere to go
    return T(t["title"][:160], kind, max(5, min(300, int(t["est_min"]))), t.get("detail", "")[:4000], res, [],
             0 if kind in ("unit_quiz", "other") else int(t.get("learning", True)), meta)


def valid(d: date, plan: dict) -> dict:
    """Keep what fits each block (15 minutes of slack); drop the rest, one task at a time."""
    for b, key, _tr in track_slots(d):
        limit, total, keep = _minutes(b), 0, []
        for t in plan.get(key, []):
            if total + t["est_min"] > limit + 15:
                log.info("tracks: dropped %r (over the %d min block)", t["title"], limit)
                continue
            keep.append(t)
            total += t["est_min"]
        plan[key] = keep
    return plan


def context() -> str:
    from .agent import _history
    cur = cursor()
    lines = []
    for tr in profile.tracks():
        units = tr.get("units") or []
        pos = cur[tr["key"]]
        lines.append(f"Track {tr['key']} '{tr['label']}': at unit {pos['unit'] + 1} session {pos['session'] + 1} of "
                     f"{len(units)} units. Units: " + "; ".join(
                         f"{i}. {u['title']}" + (" (REMOVED by the user: never plan it)" if removed(u) else "")
                         for i, u in enumerate(units, 1)))
    exams = exam_dates(profile.tracks())
    if exams:
        names = {tr["key"]: tr["label"] for tr in profile.tracks()}
        lines.append("Exams (nearest first; a day's review favours the nearest exam still ahead): " + "; ".join(
            f"{names[k]} on {v.isoformat()} ({(v - today()).days} days from today)" if v >= today() else f"{names[k]} on {v.isoformat()} (over)"
            for k, v in sorted(exams.items(), key=lambda kv: kv[1])))
    stuck = db.q("SELECT summary, source, date FROM stuck WHERE resolved=0 ORDER BY id DESC LIMIT 30")
    checks = db.q("SELECT date, item, value, max, passed FROM scores WHERE kind='unit_quiz' ORDER BY id DESC LIMIT 20")
    return ("\n".join(lines) +
            f"\nRecent unit checks: {json.dumps(checks, ensure_ascii=False)}"
            f"\nRecent days: {json.dumps(_history(7), ensure_ascii=False, default=str)[:12000]}"
            f"\nOpen sticking points: {json.dumps(stuck, ensure_ascii=False)}")


async def llm_plan(d: date, draft: dict, ctx: str) -> tuple[dict, str] | None:
    if not has_api_key():
        return None
    ts = track_slots(d)
    if not ts:
        return None
    view = [{"key": key, "track": tr["key"], "track_label": tr["label"], "minutes": _minutes(b),
             "tasks": [{"title": t["title"], "kind": t["kind"], "est_min": t["est_min"], "detail": t["detail"][:300],
                        "unit": (t.get("meta") or {}).get("unit")} for t in draft.get(key, [])]} for b, key, tr in ts]
    prompt = (f"Day: {d.isoformat()} {WEEKDAY_TR[d.weekday()]} (week {profile.week_no(week_index(d))}).\n\n"
              f"Draft (built by the planner rules; improve it and fill the gaps; keep every block key):\n"
              f"{json.dumps(view, ensure_ascii=False, indent=1)}\n\nContext:\n{ctx}")
    try:
        out = await llm.structured(prompts.planner_system(), prompt, PLAN_SCHEMA, effort="high", max_tokens=32000)
    except Exception:
        log.exception("tracks planner LLM failed for %s", d)
        return None
    by_key = {key: tr for _b, key, tr in ts}
    plan = dict(draft)
    for blk in out.get("blocks", []):
        tr = by_key.get(blk.get("key"))
        if tr and blk.get("tasks"):
            here = next((m["unit"] for x in draft.get(blk["key"], []) if isinstance((m := x.get("meta") or {}).get("unit"), int)), None)
            # a unit the user took out of the plan is never planned, whatever the model wrote
            plan[blk["key"]] = [x for x in (_to_internal(t, tr, here) for t in blk["tasks"])
                                if not is_removed(tr, x["meta"].get("unit"))]
            b = next((b for b, key, _tr in ts if key == blk["key"]), {})
            for t in plan[blk["key"]]:
                t["meta"] |= _moved(b, tr)
    plan = valid(d, plan)
    # a block whose tasks were all dropped keeps the draft: a block is never planned bare
    for _b, key, _tr in ts:
        if draft.get(key) and not plan.get(key):
            log.info("tracks: %s came back empty for %s; keeping the draft", key, d)
            plan[key] = valid(d, {key: draft[key]})[key] or draft[key]
    return plan, out.get("adapt_note", "")


# ------------------------------------------------------------------ how much is left
def runway() -> list[dict]:
    cur = cursor()
    out = []
    for tr in profile.tracks():
        units = tr.get("units") or []
        pos = settle(units, dict(cur[tr["key"]]))
        out.append({"key": tr["key"], "label": tr["label"], "units": sum(1 for u in units if not removed(u)),
                    "left": len(ahead(units, pos))})
    return out


def check_runway() -> list[dict]:
    r = runway()
    for t in r:
        if t["left"] <= RUNWAY_WARN_UNITS:
            health.warn(f"runway_track_{t['key']}",
                        f"{t['label']}: {t['left']} unit(s) left. After that its blocks review earlier units; ask the "
                        "coach to propose the next units and approve them (Settings → Plan).")
        else:
            health.clear(f"runway_track_{t['key']}")
    return r


def progress() -> list[dict]:
    """Per track, each unit's state for the Progress page: passed (its check passed), tried (below the mark), current
    (the first unit not passed yet: what the user is on), planned (already on a planned day) or todo."""
    cur = cursor()
    out = []
    for tr in profile.tracks():
        units, seen_current = [], False
        for i, u in enumerate(tr.get("units") or []):
            best = db.q1("SELECT MAX(value) AS v, MAX(max) AS m, MAX(passed) AS p FROM scores WHERE kind='unit_quiz' "
                         "AND item=?", (item(tr, i),))
            tried = best is not None and best["v"] is not None
            if tried and best["p"]:
                status = "passed"
            elif removed(u):
                status = "removed"
            elif not seen_current:
                status = "tried" if tried else "current"
                seen_current = True
            elif tried:
                status = "tried"
            else:
                status = "planned" if i < cur[tr["key"]]["unit"] else "todo"
            units.append({"idx": i, "name": u["title"], "status": status, "removed": removed(u),
                          "best": best["v"] if tried else None, "max": best["m"] if tried else None})
        out.append({"key": tr["key"], "label": tr["label"], "units": units})
    return out

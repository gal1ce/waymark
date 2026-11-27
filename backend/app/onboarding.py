"""Setting up a study plan: the onboarding answers go to the model, which drafts a plan (weekly schedule, tracks of
units with sources, pass marks, goals, milestones, the coach's context). The app checks the draft and fixes or drops
what breaks its rules, the user reads it and asks for changes, and only an approved draft becomes the plan.

A plan the user already has (a Markdown or text file, e.g. a COACH.md) can be given as the starting point: the model
converts it. The file itself is only read, never changed, and only the approved result is kept.

State lives in kv 'onboarding': {status: idle | drafting | ready | failed, answers, draft, warnings, error}."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from . import bus, db, health, llm, planlog, profile, state
from .config import WEEKDAY_TR, has_api_key, today

log = logging.getLogger("ctu.onboarding")

TIME = re.compile(r"([01]\d|2[0-3]):[0-5]\d")
MAX_TRACKS = 6
MAX_UNITS = 60
MAX_WEEK_MIN = 80 * 60
PLAN_TEXT_MAX = 100_000
LINK_CHECKS = 80

_running: set[str] = set()


# ------------------------------------------------------------------ the answers
def _s(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n] if n <= 200 else str(v or "").strip()[:n]


def clean_answers(a: dict) -> dict:
    """The onboarding answers, checked. Raises Refused with what is missing."""
    if not isinstance(a, dict):
        raise state.Refused("The answers are missing.")
    out = {
        "field": _s(a.get("field"), 120), "level": _s(a.get("level"), 60), "goal": _s(a.get("goal"), 800),
        "deadline": _s(a.get("deadline"), 10), "background": _s(a.get("background"), 2000),
        "focus": _s(a.get("focus"), 1500), "sources": _s(a.get("sources"), 1500),
        "day_start": _s(a.get("day_start"), 5) or "09:00", "day_end": _s(a.get("day_end"), 5) or "17:00",
        "language": a.get("language") if a.get("language") in ("auto", "tr", "en") else "auto",
        "code": bool(a.get("code")), "plan_text": str(a.get("plan_text") or "")[:PLAN_TEXT_MAX],
        "plan_file": _s(a.get("plan_file"), 120),
    }
    try:
        out["hours"] = max(1, min(12, int(a.get("hours") or 6)))
    except (TypeError, ValueError):
        out["hours"] = 6
    days = a.get("weekdays")
    if not isinstance(days, list) or not days or not all(isinstance(d, int) and 0 <= d <= 6 for d in days):
        raise state.Refused("Choose at least one study day.")
    out["weekdays"] = sorted(set(days))
    for k in ("day_start", "day_end"):
        if not TIME.fullmatch(out[k]):
            raise state.Refused("Times are written as HH:MM.")
    if _mins(out["day_end"]) - _mins(out["day_start"]) < 60:
        raise state.Refused("The study day has to be at least an hour long.")
    try:
        start = date.fromisoformat(str(a.get("start_date") or ""))
    except ValueError:
        start = today()
    out["start_date"] = max(start, today()).isoformat()
    # the deadline: a day (2027-06-15) or, from older answers, a month (2027-06)
    if out["deadline"]:
        if not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?", out["deadline"]):
            raise state.Refused("The deadline is a date, like 2027-06-15.")
        if len(out["deadline"]) == 10:
            try:
                due = date.fromisoformat(out["deadline"])
            except ValueError:
                raise state.Refused("The deadline is a date, like 2027-06-15.") from None
            if due <= date.fromisoformat(out["start_date"]):
                raise state.Refused("The deadline has to come after the start.")
    if not out["field"] and not out["plan_text"]:
        raise state.Refused("Say what you study (or start from a plan file).")
    if not out["goal"] and not out["plan_text"]:
        raise state.Refused("Say what the plan is for: the goal.")
    return out


def _mins(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def _hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


# ------------------------------------------------------------------ the model's draft
RES = {"type": "object", "properties": {"label": {"type": "string"}, "href": {"type": "string"}}}
UNIT = {"type": "object", "properties": {"title": {"type": "string"}, "objective": {"type": "string"},
                                         "practice": {"type": "string"}, "sessions": {"type": "integer"},
                                         "resources": {"type": "array", "items": RES}}}
DRAFT_SCHEMA = llm.strict({"type": "object", "properties": {
    "label": {"type": "string"}, "summary": {"type": "string"}, "deadline": {"type": "string"},
    "week": {"type": "array", "items": {"type": "object", "properties": {
        "weekday": {"type": "integer"},
        "blocks": {"type": "array", "items": {"type": "object", "properties": {
            "start": {"type": "string"}, "end": {"type": "string"}, "track": {"type": "string"},
            "title": {"type": "string"}}}}}}},
    "tracks": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string"}, "label": {"type": "string"}, "goal": {"type": "string"},
        "deadline": {"type": "string"}, "units": {"type": "array", "items": UNIT}}}},
    "goals": {"type": "array", "items": {"type": "object", "properties": {
        "label": {"type": "string"}, "target": {"type": "string"}, "note": {"type": "string"}}}},
    "unit_pass": {"type": "integer"},
    "roadmap": {"type": "array", "items": {"type": "object", "properties": {
        "start": {"type": "string"}, "end": {"type": "string"}, "items": {"type": "array", "items": {"type": "string"}}}}},
    "coach": {"type": "object", "properties": {
        "intro": {"type": "string"}, "context": {"type": "string"}, "learning_work": {"type": "string"},
        "own_work": {"type": "string"}, "practice_subjects": {"type": "string"}, "stuck_examples": {"type": "string"}}},
    "planner_rules": {"type": "string"}, "eod_rules": {"type": "string"}, "practice_rules": {"type": "string"},
    "programming": {"type": "boolean"},
    "notes": {"type": "array", "items": {"type": "string"}},
}})

DRAFT_SYSTEM = """You are an experienced academic advisor drafting a serious study plan inside a study app for university-level and graduate learners (math, computer science, physics; undergraduates, master's and PhD students, and self-taught people working at that level). Write everything in ENGLISH (the app's content language); the user's own words may be in another language.

What you write is a DRAFT: the app checks it, the user reads it and asks for changes, and nothing runs until the user approves it.

The plan's shape:
- tracks: 1 to 4 (at most 6) parallel lines of study, each a course, a book or a topic sequence (e.g. "Real analysis (Abbott → Rudin ch. 1–7)", "Algorithms (CLRS + problem sets)", "QFT (Peskin & Schroeder Part I)", "Thesis: literature + writing"). key: a short lowercase word. Order the units the way the subject is really learned; each unit is a coherent chunk (a book chapter or a course week).
- units: title (short), objective (one or two sentences: what the user can DO after it: prove, derive, implement, solve), practice (which problems to work and what kind they are: "Abbott 1.2: exercises 1–12, odd ones first (sup/inf of concrete sets)", "OCW 18.06 pset 3"; name exercise numbers only for an edition you are sure of, otherwise describe the problems: "eight limits of rational functions that need factoring first"), sessions (how many blocks of that track the unit takes, 1–6, honest about the difficulty and the user's background), resources (0–4).
- deadline: the day (YYYY-MM-DD) the user has to be ready by: the deadline in the answers, or one the user names in their words or in a change request ("my midterm is in 3 weeks" → the start date + 21 days). Empty string when there is none. The app works out from the schedule and the units' sessions when the plan really ends and shows it next to this date.
- tracks[].deadline: that course's own exam day (YYYY-MM-DD) when the user named separate dates ("calculus midterm Dec 10, linear algebra Dec 17"); empty string otherwise. Size each track so its last unit ends a few days before its own exam. The app gives the blocks of a course whose exam is over to the next exam, and in the last week before an exam its unfinished units take blocks from courses whose exam is far away.
- label: a name for the plan. Name a length in it ("3-week …") only when the units really fit in that time at this schedule; otherwise leave the length out.
- Cover the time until the goal or deadline at the user's pace; when there is a deadline, size the units' sessions so the last unit ends a few days before it, leaving those days for review; if that is more than about six months, plan the first six months in units and put the rest into the roadmap.
- resources: every unit has at least one source the user can open for free right now: an open textbook (OpenStax, LibreTexts, Hammack's Book of Proof, Erickson's Algorithms, Levin's Discrete Mathematics, Axler's Linear Algebra Done Right (open access)), course notes and problem sets (MIT OpenCourseWare, Paul's Online Math Notes), or Wikipedia. Put it first. A paid textbook comes only when the user named it in their sources or plan file, or as a second source next to a free one.
- resources: href only when you are certain the exact URL exists and is stable (official course pages such as ocw.mit.edu, a book's or author's own site, arxiv.org/abs/… for a paper you know, Wikipedia articles). Otherwise leave href empty and name the book and chapter in label ("Abbott, Understanding Analysis, ch. 2"). Never invent a URL.
- week: one entry per study day (weekday 0 = Monday … 6 = Sunday), only the days the user chose, inside their day start and end. Blocks are 45–240 minutes; mix tracks across the week; put a short break (track "break") between long blocks and a lunch break when the day crosses midday. The net study time per day must be close to the user's hours. End every study day with one 30-minute block with track "test" (the end-of-day test). Times are HH:MM, blocks in order, never overlapping. title: the block's name as shown in the calendar (usually the track's short label).
- goals: 1–3 measurable goals the user stated or clearly implied (exam, qualifying exam, thesis chapter, paper, application), with target and a short note.
- unit_pass: right answers out of 5 needed to pass the closed-book unit check that ends each unit (4 is the default; 5 only for foundations the rest depends on).
- roadmap: 3–8 milestones (start and end as YYYY-MM) from the start date to the goal. The app redraws the part the units cover from the schedule; yours matters for what comes after them.
- summary and label: never state how long the plan takes ("a three-month roadmap") unless the units really take that long at this schedule; with no deadline, say the plan goes through the material at the user's pace. The app shows the real end date.
- coach: intro = 2–3 sentences, second person about the user ("The user is a first-year PhD student in physics preparing for…"), starting with "You are the user's study coach inside their study app." context = the sources and how the work is done (books, courses, how problems are checked) in a few sentences. learning_work = a comma list of the user's own work the coach must never solve for them (problem sets, proofs, …). own_work = a short list like "their assigned problem, proof or derivation". practice_subjects = the subjects the coach may write practice questions in. stuck_examples = two short, concrete, quoted examples of sticking points in this field.
- planner_rules: 3–6 lines starting with "- ", field-specific rules for writing a day's tasks (e.g. "- Proofs: write every proof in full; a proof is done when each step cites a definition or a theorem."). eod_rules: 2 lines starting with "- " on the end-of-day test for this field. practice_rules: 2–4 lines starting with "- " on practice tests per subject (types: mcq, short; output only for programming).
- programming: true when the plan has programming work (code tasks, code questions). It follows "Programming in the plan" in the answers unless a change request asks to add or remove it; then it follows the change request. Never say in notes or summary that programming was left out "because of your preference" unless the answers say no and nothing the user wrote asks for it.
- notes: what you were unsure about or the user should check (e.g. "the 18.06 link is the 2010 version"), at most 6.

If the user gave a plan of their own (a file), it is the primary source: keep its goals, order, sources and pass marks, converted into this shape, and say in notes what you could not carry over. Do not copy personal data from it beyond what the plan needs.
If the user asked for changes to an earlier draft, apply them and keep everything else as it was."""


def _prompt(a: dict, earlier: dict | None = None, change: str = "") -> str:
    days = ", ".join(WEEKDAY_TR[d] for d in a["weekdays"])
    parts = [f"Today: {today().isoformat()}. The plan starts on {a['start_date']}.",
             f"Field: {a['field'] or '(see the plan file)'}", f"Level: {a['level'] or 'not said'}",
             f"Goal: {a['goal'] or '(see the plan file)'}", f"Deadline: {a['deadline'] or 'none given'}",
             f"Background (what they already know): {a['background'] or 'not said'}",
             f"Topics they want: {a['focus'] or 'not said'}", f"Sources they prefer: {a['sources'] or 'none named'}",
             f"Study days: {days}; between {a['day_start']} and {a['day_end']}, about {a['hours']} hours of net study a day.",
             f"Programming in the plan: {'yes' if a['code'] else 'no'}."]
    unsaid = [n for n, k in (("level", "level"), ("background", "background"), ("topics", "focus")) if not a.get(k)]
    if unsaid and not a["plan_text"]:
        parts.append(f"Not said: {', '.join(unsaid)}. Assume what fits the field and goal (a typical student at that point), "
                     "and put one note per assumption in notes, saying what you assumed, so the user can correct it.")
    if a["plan_text"]:
        parts.append(f"\nThe user's own plan ({a['plan_file'] or 'pasted text'}), the primary source:\n"
                     f"<plan_file>\n{a['plan_text']}\n</plan_file>")
    if earlier:
        parts.append("\nThe earlier draft (as JSON):\n" + json.dumps(earlier, ensure_ascii=False)[:60000])
        if any(u.get("skip") for t in earlier.get("tracks") or [] for u in t.get("units") or []):
            parts.append('Units with "skip": true were taken out by the user. Keep them in the list with the same title '
                         "(the app keeps them out of the schedule); don't add them back as new units.")
    if change:
        parts.append(f"\nThe user asks for these changes to that draft:\n{change}")
    return "\n".join(parts)


# ------------------------------------------------------------------ checking the draft
def _key(s: str, used: set[str]) -> str:
    k = re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")[:16] or "track"
    if k in ("break", "test") or not k[0].isalpha():
        k = "t_" + k
    base, n = k, 2
    while k in used:
        k = f"{base}{n}"
        n += 1
    used.add(k)
    return k


def _resources(rs, notes: list[str]) -> list[dict]:
    out = []
    for r in (rs or [])[:4]:
        label = _s(r.get("label"), 140)
        href = (r.get("href") or "").strip()
        if href and not re.fullmatch(r"https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?", href):
            notes.append(f"A source link was dropped (not an https address): {href[:80]}")
            href = ""
        if label or href:
            out.append({"label": label or href, "href": href})
    return out


def normalize(raw: dict, a: dict) -> tuple[dict, list[str]]:
    """The model's draft turned into a plan the app can run, plus what the app changed or dropped (shown to the user).
    Raises Refused when nothing usable is left."""
    notes = [_s(n, 300) for n in raw.get("notes") or [] if _s(n, 300)][:6]
    fixes: list[str] = []
    used: set[str] = set()
    tracks, keymap = [], {}
    for t in (raw.get("tracks") or [])[:MAX_TRACKS]:
        units = []
        for u in (t.get("units") or [])[:MAX_UNITS]:
            title = _s(u.get("title"), 120)
            if not title:
                continue
            try:
                sessions = max(1, min(6, int(u.get("sessions") or 1)))
            except (TypeError, ValueError):
                sessions = 1
            units.append({"title": title, "objective": _s(u.get("objective"), 600),
                          "practice": _s(u.get("practice"), 600), "sessions": sessions,
                          "resources": _resources(u.get("resources"), fixes)})
        label = _s(t.get("label"), 80)
        if not units or not label:
            continue
        k = _key(t.get("key") or label, used)
        keymap[(t.get("key") or "").strip().lower()] = k
        keymap[label.lower()] = k
        tracks.append({"key": k, "label": label, "goal": _s(t.get("goal"), 400), "units": units,
                       "deadline": _deadline(t.get("deadline"))})
    if not tracks:
        raise state.Refused("The draft has no usable tracks. Try again, or say more about what you study.")

    day_lo, day_hi = _mins(a["day_start"]), _mins(a["day_end"])
    week: list[list[dict]] = [[] for _ in range(7)]
    by_day = {}
    for w in raw.get("week") or []:
        if isinstance(w.get("weekday"), int) and 0 <= w["weekday"] <= 6:
            by_day[w["weekday"]] = w.get("blocks") or []
    first_key = tracks[0]["key"]
    for wd in a["weekdays"]:
        blocks, last = [], day_lo
        for b in by_day.get(wd, []):
            s, e = str(b.get("start", "")), str(b.get("end", ""))
            if not (TIME.fullmatch(s) and TIME.fullmatch(e)):
                fixes.append(f"{WEEKDAY_TR[wd]}: a block with an unreadable time was dropped.")
                continue
            s_m, e_m = max(_mins(s), last), min(_mins(e), day_hi)
            if e_m - s_m < 15:
                if _mins(e) - _mins(s) >= 15:
                    fixes.append(f"{WEEKDAY_TR[wd]} {s}–{e}: dropped (overlaps another block or falls outside your day).")
                continue
            asked = str(b.get("track") or "").strip().lower()
            kind = "break" if asked == "break" else "test" if asked == "test" else keymap.get(asked, "")
            if not kind:
                fixes.append(f"{WEEKDAY_TR[wd]} {s}–{e}: '{_s(b.get('title') or asked, 40)}' isn't a track of the "
                             f"plan; the block became {tracks[0]['label']}.")
                kind = first_key
                b = {**b, "title": ""}
            if kind != "break" and e_m - s_m > 240:
                fixes.append(f"{WEEKDAY_TR[wd]} {s}–{e}: shortened to 4 hours (the longest block).")
                e_m = s_m + 240
            title = _s(b.get("title"), 40) or ("Break" if kind == "break" else "End-of-day test" if kind == "test"
                                               else next(t["label"] for t in tracks if t["key"] == kind))
            blocks.append({"start": _hhmm(s_m), "end": _hhmm(e_m), "kind": kind, "title": title})
            last = e_m
        tests = [b for b in blocks if b["kind"] == "test"]
        for extra in tests[:-1]:
            blocks.remove(extra)
        if not any(b["kind"] not in ("break", "test") for b in blocks):
            # the model left the day empty: one block of the first track, then the test
            end = min(day_hi - 30, day_lo + a["hours"] * 60)
            blocks = [{"start": _hhmm(day_lo), "end": _hhmm(max(day_lo + 45, end)), "kind": first_key,
                       "title": tracks[0]["label"]}]
            fixes.append(f"{WEEKDAY_TR[wd]}: the draft had no study blocks; one {tracks[0]['label']} block was added.")
        if not tests:
            s_m = _mins(blocks[-1]["end"])
            if s_m + 30 <= day_hi + 60 and s_m + 30 <= 24 * 60 - 1:
                blocks.append({"start": _hhmm(s_m), "end": _hhmm(s_m + 30), "kind": "test", "title": "End-of-day test"})
        elif blocks[-1]["kind"] != "test":
            blocks.remove(tests[-1])
            s_m = _mins(blocks[-1]["end"])
            blocks.append({**tests[-1], "start": _hhmm(s_m), "end": _hhmm(min(s_m + 30, 24 * 60 - 1))})
        while blocks and blocks[0]["kind"] == "break":
            blocks.pop(0)
        week[wd] = blocks
    total = sum(_mins(b["end"]) - _mins(b["start"]) for d in week for b in d if b["kind"] != "break")
    if total > MAX_WEEK_MIN:
        raise state.Refused(f"The draft plans {total // 60} hours a week; that is more than anyone can study. Ask for fewer.")
    for tr in tracks:
        if not any(b["kind"] == tr["key"] for d in week for b in d):
            fixes.append(f"'{tr['label']}' has no block in the week, so it would never be studied. Ask for a change.")

    try:
        unit_pass = max(3, min(5, int(raw.get("unit_pass") or 4)))
    except (TypeError, ValueError):
        unit_pass = 4
    goals = [{"label": _s(g.get("label"), 60), "target": _s(g.get("target"), 40), "note": _s(g.get("note"), 160)}
             for g in (raw.get("goals") or [])[:4] if _s(g.get("label"), 60)]
    roadmap = []
    for r in (raw.get("roadmap") or [])[:10]:
        s, e = str(r.get("start", "")), str(r.get("end", ""))
        if re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", s) and re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", e) and s <= e:
            items = [_s(x, 140) for x in r.get("items") or [] if _s(x, 140)][:8]
            if items:
                roadmap.append({"start": s, "end": e, "items": items})
    c = raw.get("coach") or {}
    plan = build(a, {
        "label": _s(raw.get("label"), 80) or f"{a['field'] or 'Study'} plan",
        "summary": _s(raw.get("summary"), 1200), "tracks": tracks, "week": week, "goals": goals, "roadmap": roadmap,
        "unit_pass": unit_pass,
        "coach": {k: _s(c.get(k), 1500 if k in ("intro", "context") else 400) for k in
                  ("intro", "context", "learning_work", "own_work", "practice_subjects", "stuck_examples")},
        "planner_rules": _lines(raw.get("planner_rules"), 6), "eod_rules": _lines(raw.get("eod_rules"), 3),
        "practice_rules": _lines(raw.get("practice_rules"), 5),
    })
    fixes += _timeline(plan, raw, a)
    return plan, notes + fixes


_CODE_WORDS = re.compile(r"(?i)\b(python|java(?:script)?|c\+\+|rust|golang|haskell|programming|coding|code|"
                        r"implement(?:ation)?s?)\b|\bC\b(?![#+])")


def _programming(raw: dict, a: dict, change: str) -> tuple[dict, list[str]]:
    """Programming in the plan, checked against what the user said. A change request decides it (the model reads
    it; its 'programming' answer is taken). Otherwise the setup answer stands, and when the user's own words
    mention programming but the answer says no, the draft says so instead of silently leaving code out."""
    said = bool(a.get("code"))
    if change and isinstance(raw.get("programming"), bool) and raw["programming"] != said:
        return {**a, "code": raw["programming"]}, [
            "Programming is now in the plan, as you asked: tests get code questions and the plan gets code tasks."
            if raw["programming"] else "Programming is out of the plan now, as you asked."]
    words = " ".join(str(a.get(k) or "") for k in ("goal", "background", "focus", "sources"))
    if not said and (m := _CODE_WORDS.search(words)):
        return a, [f"You answered that the plan has no programming, but your answers mention \"{m.group(0)}\". "
                   "If you want code tasks and code questions, ask for programming below."]
    return a, []


def _deadline(v) -> str:
    """A deadline as a day: YYYY-MM-DD as it is, YYYY-MM (older answers) as that month's last day; '' otherwise."""
    v = str(v or "").strip()
    if re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", v):
        y, m = map(int, v.split("-"))
        return (date(y + m // 12, m % 12 + 1, 1) - timedelta(days=1)).isoformat()
    try:
        return date.fromisoformat(v).isoformat() if re.fullmatch(r"20\d\d-\d\d-\d\d", v) else ""
    except ValueError:
        return ""


def _timeline(plan: dict, raw: dict, a: dict) -> list[str]:
    """Sets the plan's deadline and the day its units end (worked out by the app, never taken from the model), and
    says when the label, the deadline and that day disagree."""
    from . import tracks as tr_mod
    start = date.fromisoformat(plan["start_date"])
    out = []
    dl = _deadline(raw.get("deadline")) or _deadline(a.get("deadline")) or \
        max((t["deadline"] for t in plan["tracks"] if t.get("deadline", "") > plan["start_date"]), default="")  # the last exam
    if dl and date.fromisoformat(dl) <= start:
        out.append(f"The draft's deadline ({dl}) is not after the start; it was left out.")
        dl = ""
    end = tr_mod.finish(plan["week"], plan["tracks"], start)
    plan["deadline"], plan["end_date"] = dl, end.isoformat() if end else ""
    plan["track_ends"] = tr_mod.track_ends(plan["week"], plan["tracks"], start)
    if dl and not plan["answers"].get("deadline"):
        plan["answers"]["deadline"] = dl   # named in a change request: the questions show it next time
    if dl or end:
        plan["coach"]["context"] += (f" Deadline: {dl or 'none'}." + (f" At this schedule the last unit ends on "
                                     f"{end.isoformat()} if every unit check passes the first time." if end else ""))
    out += _course_exams(plan, start)
    if not end:
        return out
    weeks = (end - start).days // 7 + 1
    out += _roadmap_from_schedule(plan, start, end, dl)
    if dl and end > date.fromisoformat(dl):
        out.append(f"At this schedule the last unit ends on {end.isoformat()} ({weeks} weeks), after the deadline "
                   f"{dl}. Ask for fewer units or sessions, or more hours, so it fits.")
    m = re.search(r"(\d+)[\s-]*(week|month)", plan["label"], re.I)
    if m:
        said = int(m.group(1)) * (1 if m.group(2).lower() == "week" else 4)
        if abs(said - weeks) > max(1, said // 4):
            out.append(f"The plan is called \"{plan['label']}\" but its units take {weeks} weeks at this schedule "
                       f"(last unit {end.isoformat()}).")
    for sent in re.split(r"(?<=[.!?])\s+", plan.get("summary") or ""):
        n = _length_in(sent, weeks)
        if n:   # "establishes a three-month roadmap" when the units take four weeks: the sentence goes
            plan["summary"] = " ".join(plan["summary"].replace(sent, "").split())
            out.append(f"The summary said {n} but its units take {weeks} weeks at this schedule (last unit "
                       f"{end.isoformat()}); that sentence was left out.")
    return out


_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
        "twelve": 12}


def _length_in(text: str, weeks: int) -> str:
    """'a three-month roadmap' → 'three-month' when that length is far from the weeks the units really take."""
    for m in re.finditer(r"(?i)\b(\d+|" + "|".join(_NUM) + r")[\s-]*(week|month)s?\b", text):
        n = int(m.group(1)) if m.group(1).isdigit() else _NUM[m.group(1).lower()]
        said = n * (1 if m.group(2).lower() == "week" else 4.3)
        if abs(said - weeks) > max(1, said / 4):
            return m.group(0)
    return ""


def _roadmap_from_schedule(plan: dict, start: date, end: date, dl: str) -> list[str]:
    """The roadmap follows the schedule, so it can't disagree with the day the units end: one milestone per month
    with the units that end in it. Only past the units' end (a long deadline) do the model's own milestones stay,
    as the part not planned in units yet, and a review stretch fills the time left before the deadline."""
    from . import tracks as tr_mod
    months: dict[str, list[str]] = {}
    for d, label, title in tr_mod.unit_ends(plan["week"], plan["tracks"], start):
        months.setdefault(d.strftime("%Y-%m"), []).append(f"{label}: finish {title}")
    rm = [{"start": m, "end": m, "items": items[:8]} for m, items in sorted(months.items())]
    last = end.strftime("%Y-%m")
    if dl and dl[:7] > last:
        later = [r for r in plan.get("roadmap") or [] if r["start"] > last and r["start"] <= dl[:7]]
        rm += later or [{"start": (end + timedelta(days=1)).strftime("%Y-%m"), "end": dl[:7],
                         "items": [f"Review every track and practise mixed problems before {dl}"]}]
    model = plan.get("roadmap") or []
    plan["roadmap"] = rm
    beyond = [r for r in model if r["end"] > (dl[:7] if dl else last)]
    if beyond:
        return [f"The model's milestones ran to {max(r['end'] for r in model)}, but the units end on {end.isoformat()}"
                + (f" and the deadline is {dl}" if dl else " and there is no deadline")
                + ". The roadmap now follows the schedule."]
    return []


def _course_exams(plan: dict, start: date) -> list[str]:
    """Per-course exam dates: dropped when not after the start, then each course's last unit is checked against its
    own exam (with the app's exam rules applied to the schedule). The coach is told the dates."""
    from . import tracks as tr_mod
    out = []
    for t in plan["tracks"]:
        if t.get("deadline") and date.fromisoformat(t["deadline"]) <= start:
            out.append(f"{t['label']}: the exam date {t['deadline']} is not after the start; it was left out.")
            t["deadline"] = ""
    dated = [t for t in plan["tracks"] if t.get("deadline")]
    if not dated:
        return out
    last = {}
    for d, label, _title in tr_mod.unit_ends(plan["week"], plan["tracks"], start):
        last[label] = d
    for t in sorted(dated, key=lambda t: t["deadline"]):
        e = last.get(t["label"])
        if e is None or e > date.fromisoformat(t["deadline"]):
            out.append(f"{t['label']}: at this schedule its last unit ends " + (f"on {e.isoformat()}" if e else "never")
                       + f", after its exam on {t['deadline']}. Ask for fewer units or sessions in it, or more of its blocks.")
    plan["coach"]["context"] += " Exams: " + "; ".join(
        f"{t['label']} on {t['deadline']}" + (f" (its last unit ends {last[t['label']].isoformat()})" if t["label"] in last else "")
        for t in sorted(dated, key=lambda t: t["deadline"])) + "."
    return out


def set_exams(dates: dict[str, str]) -> dict:
    """Exam dates per course on the approved plan, set by the user in Settings → Plan (their own change, so no
    draft). Days already planned keep their blocks; the days planned from now on follow the new dates."""
    from . import tracks as tr_mod
    if profile.key() != "custom":
        raise state.Refused("Exam dates per course belong to a plan of your own.")
    plan = json.loads(json.dumps(db.kv_get("plan", {})))
    start = date.fromisoformat(plan["start_date"])
    keys = {t["key"] for t in plan["tracks"]}
    for k, v in dates.items():
        if k not in keys:
            raise state.Refused(f"No course '{k}' in the plan.")
        v = _deadline(v)
        if v and date.fromisoformat(v) <= max(start, today()):
            raise state.Refused("An exam date has to be in the future.")
    changed = []
    for t in plan["tracks"]:
        if t["key"] in dates and (t.get("deadline") or "") != _deadline(dates[t["key"]]):
            t["deadline"] = _deadline(dates[t["key"]])
            changed.append(f"{t['label']}: {t['deadline'] or 'no exam date'}")
    if not changed:
        return {"notes": [], "changed": []}
    ctx = plan["coach"]["context"]   # the exams sentence is always the context's last (see _course_exams)
    plan["coach"]["context"] = ctx[:ctx.rfind(" Exams: ")] if " Exams: " in ctx else ctx
    notes = _course_exams(plan, start)
    exams = [t["deadline"] for t in plan["tracks"] if t.get("deadline")]
    if exams and (not plan.get("deadline") or plan["deadline"] < max(exams)):
        plan["deadline"] = max(exams)
    end = tr_mod.finish(plan["week"], plan["tracks"], start)
    plan["end_date"] = end.isoformat() if end else ""
    plan["track_ends"] = tr_mod.track_ends(plan["week"], plan["tracks"], start)
    db.kv_set("plan", plan)
    profile.reload()
    planlog.add("Exam dates changed: " + "; ".join(changed) + ". Days planned from now on follow them.", "Plan")
    planlog.write()
    return {"notes": notes, "changed": changed}


def _retime(plan: dict, roadmap: bool) -> None:
    """The plan's projected end and each course's last unit day, worked out again after units were taken out or put
    back (from the start, as at approval); for a draft the roadmap follows too."""
    from . import tracks as tr_mod
    start = date.fromisoformat(plan["start_date"])
    end = tr_mod.finish(plan["week"], plan["tracks"], start)
    plan["end_date"] = end.isoformat() if end else ""
    plan["track_ends"] = tr_mod.track_ends(plan["week"], plan["tracks"], start)
    if end:
        ctx = plan["coach"].get("context") or ""
        plan["coach"]["context"] = re.sub(r"(At this schedule the last unit ends on )\d{4}-\d\d-\d\d", rf"\g<1>{end.isoformat()}", ctx)
        if roadmap:
            _roadmap_from_schedule(plan, start, end, plan.get("deadline") or "")


def _toggle(plan: dict, key: str, idx: int, on: bool) -> tuple[dict, dict] | None:
    """Takes a unit out of a plan (on=False) or puts it back: a flag on the unit, so it keeps its place and its number.
    None when it already was that way. A course keeps at least one unit."""
    tr = next((t for t in plan.get("tracks") or [] if t["key"] == key), None)
    if not tr:
        raise state.Refused(f"No course '{key}' in the plan.")
    units = tr.get("units") or []
    if not (isinstance(idx, int) and 0 <= idx < len(units)):
        raise state.Refused("No such unit in that course.")
    u = units[idx]
    if on != bool(u.get("skip")):
        return None
    if not on and sum(1 for x in units if not x.get("skip")) <= 1:
        raise state.Refused("A course keeps at least one unit. To drop the whole course, ask for a change to the plan.")
    if on:
        u.pop("skip", None)
    else:
        u["skip"] = True
    return tr, u


def set_draft_unit(key: str, idx: int, on: bool) -> dict:
    """A unit taken out of the draft under review, or put back. Nothing is planned yet; the draft's end date, the
    courses' last unit days and the roadmap follow at once."""
    if "draft" in _running:
        raise state.Refused("Wait until the draft is written.")
    st = db.kv_get("onboarding", None) or {}
    draft = (st.get("draft") or {}).get("plan")
    if st.get("status") != "ready" or not draft:
        raise state.Refused("There is no finished draft to change.")
    if _toggle(draft, key, idx, on):
        _retime(draft, roadmap=True)
        _set(st)
    return status()


def set_plan_unit(key: str, idx: int, on: bool) -> bool:
    """The same on the approved plan (planner.set_unit plans the days ahead again). A unit whose check is passed
    already can't be taken out: it is done. Returns whether anything changed."""
    from . import tracks as tr_mod
    if profile.key() != "custom":
        raise state.Refused("Taking units out is for a plan of your own.")
    plan = json.loads(json.dumps(db.kv_get("plan", {})))
    tr = next((t for t in plan.get("tracks") or [] if t["key"] == key), None)
    if tr and not on and 0 <= idx < len(tr.get("units") or []) and db.q1(
            "SELECT 1 FROM scores WHERE kind='unit_quiz' AND item=? AND passed=1 LIMIT 1", (tr_mod.item(tr, idx),)):
        raise state.Refused("That unit is passed already; it stays in the plan.")
    got = _toggle(plan, key, idx, on)
    if not got:
        return False
    tr, u = got
    _retime(plan, roadmap=False)
    db.kv_set("plan", plan)
    profile.reload()
    planlog.add((f"Unit put back into the plan: {tr['label']} · {u['title']}." if on else
                 f"Unit taken out of the plan: {tr['label']} · {u['title']}. Work already done on it stays.")
                + " Days not started yet were planned again.", "Plan")
    planlog.write()
    return True


def _keep_removed(plan: dict, earlier: dict | None) -> None:
    """A changed draft keeps the units the user took out of the earlier one (matched by course and title)."""
    if not earlier:
        return
    out = {(t["key"], u["title"].casefold()) for t in earlier.get("tracks") or [] for u in t.get("units") or [] if u.get("skip")}
    out |= {(t["label"].casefold(), u["title"].casefold()) for t in earlier.get("tracks") or [] for u in t.get("units") or [] if u.get("skip")}
    hit = False
    for t in plan["tracks"]:
        units = t["units"]
        for u in units:
            if ((t["key"], u["title"].casefold()) in out or (t["label"].casefold(), u["title"].casefold()) in out) \
                    and sum(1 for x in units if not x.get("skip")) > 1:
                u["skip"] = hit = True
    if hit:
        _retime(plan, roadmap=True)


def _lines(text, n: int) -> str:
    lines = [ln.strip() for ln in str(text or "").splitlines() if ln.strip()]
    lines = [ln if ln.startswith("- ") else "- " + ln.lstrip("-• ") for ln in lines][:n]
    return "\n".join(ln[:400] for ln in lines)


def _frame(week: list[list[dict]], days: list[int], tracks: list[dict]) -> str:
    """The blocks and times, written by the app from the approved week (the model never changes them)."""
    label = {t["key"]: t["label"] for t in tracks}
    parts = []
    for wd in days:
        bs = [f"{b['start']}–{b['end']} {label.get(b['kind'], b['title'])} ({_mins(b['end']) - _mins(b['start'])} min)"
              for b in week[wd] if b["kind"] not in ("break", "test")]
        parts.append(f"{WEEKDAY_TR[wd]}: " + ", ".join(bs))
    return ("Blocks and times are fixed (the user approved them; you cannot change them): " + "; ".join(parts) +
            ". Each block works on its track's current unit. You do not write the end-of-day test block.")


def build(a: dict, d: dict) -> dict:
    """The full plan from the checked parts: the app's own rules and texts are added here, never by the model."""
    tracks, week = d["tracks"], d["week"]
    days = [wd for wd in a["weekdays"] if week[wd]]
    c = d["coach"]
    hours = sum(_mins(b["end"]) - _mins(b["start"]) for wd in days for b in week[wd] if b["kind"] != "break") / 60
    unit_rule = (f"- Each unit of a track: study (kind=read) and problems (kind=practice) in its sessions; the unit's last "
                 f"session ends with its closed-book unit check (kind=unit_quiz, 20 min, learning=false). Never drop a "
                 f"unit check and never move past a unit whose check is below {d['unit_pass']}/5: study it again and "
                 f"retake the check first.\n- unit = the unit's index in its track (0-based) on every task; the Context "
                 f"says where each track is.")
    modules = ["code"] if a.get("code") else []
    words = []
    for t in tracks:
        ws = [re.escape(w) for w in re.findall(r"[A-Za-z][A-Za-z+#]{3,}", t["label"])][:4]
        if ws:
            words.append({"name": t["label"], "pattern": r"\b(" + "|".join(ws) + r")", "flags": "i"})
    thr = f"unit check (closed book, 5 questions) ≥{d['unit_pass']}/5 for every unit of every track"
    return {
        "key": "custom", "engine": "tracks", "label": d["label"], "summary": d.get("summary", ""),
        "start_date": a["start_date"], "study_weekdays": days, "week": week, "tracks": tracks,
        "modules": modules, "code_questions": bool(a.get("code")),
        "block_min": {}, "block_cap": {},
        "thresholds": {"unit_quiz": {"label": "Unit check (closed book)", "threshold": d["unit_pass"], "max": 5}},
        "goals": d["goals"], "roadmap": d["roadmap"], "topics": words,
        "coach": {
            "intro": c.get("intro") or ("You are the user's study coach inside their study app. The user follows a plan "
                                        f"for {a['field'] or 'their studies'}: {a['goal'] or d['label']}."),
            "thresholds": f"Thresholds: {thr}. Never count anything below its threshold as \"learned/done\". The server "
                          "records scores; you cannot make up scores.",
            "context": (f"study days are {', '.join(WEEKDAY_TR[x] for x in days)} (about {hours:.0f} h a week). "
                        f"Tracks: {'; '.join(t['label'] for t in tracks)}. " + (c.get("context") or "") +
                        " The plan (PLAN.md, read it with read_file scope=plan) changes only when the user approves a "
                        "change in Settings → Plan; you can propose one, never make it."),
            "learning_work": c.get("learning_work") or "", "own_work": c.get("own_work") or "",
            "practice_subjects": c.get("practice_subjects") or "", "stuck_examples": c.get("stuck_examples") or "",
        },
        "planner": {"frame": _frame(week, days, tracks), "rules": unit_rule + ("\n" + d["planner_rules"] if d["planner_rules"] else "")},
        "eod_rules": d["eod_rules"], "practice_rules": d["practice_rules"],
        "answers": {k: v for k, v in a.items() if k != "plan_text"},
    }


def check_links(plan: dict) -> list[str]:
    """Opens each source link once (HEAD, then GET) and drops the ones that don't answer, so the plan never sends the
    user to a page that isn't there. Returns what was dropped."""
    refs = [r for t in plan["tracks"] for u in t["units"] for r in u["resources"] if r.get("href")][:LINK_CHECKS]

    def ok(url: str) -> bool:
        for method in ("HEAD", "GET"):
            req = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0 (Waymark link check)"})
            try:
                with urllib.request.urlopen(req, timeout=6) as r:
                    if r.status < 400:
                        return True
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 405, 429) and method == "HEAD":
                    continue   # some sites refuse HEAD or robots; GET decides
                if e.code in (401, 403, 429):
                    return True   # it exists, it just doesn't talk to scripts
                return False
            except Exception:  # noqa: BLE001 - unreachable, bad certificate, timeout
                return False
        return False

    dropped = []
    with ThreadPoolExecutor(8) as pool:
        for r, good in zip(refs, pool.map(lambda r: ok(r["href"]), refs)):
            if not good:
                dropped.append(f"A link didn't open and was removed (the source is kept by name): {r['href'][:100]}")
                r["href"] = ""
    return dropped


# ------------------------------------------------------------------ the job
# How far the running draft is, read off the model's stream (kept in memory: it changes many times a second).
# phase: thinking (nothing written yet) → writing → checking (the app repairs the draft and opens the links).
_progress: dict = {}


def _scan(text: str) -> None:
    """What the model has written so far: the tracks it named and the units it has finished."""
    _progress["tracks"] = re.findall(r'"key"\s*:\s*"[^"]*"\s*,\s*"label"\s*:\s*"([^"]{1,80})"', text)[:8]
    _progress["units"] = len(re.findall(r'"objective"\s*:', text))


def status() -> dict:
    st = db.kv_get("onboarding", None) or {"status": "idle"}
    if st.get("status") == "drafting" and "draft" not in _running:
        st = {**st, "status": "failed", "error": "The draft was interrupted (the app restarted). Try again."}
    st.pop("answers_full", None)
    if st.get("status") == "drafting" and _progress:
        # elapsed on the server's own monotonic clock: right even when the app runs on a demo clock
        st["progress"] = {"phase": _progress.get("phase", "thinking"), "elapsed": int(time.monotonic() - _progress["t0"]),
                          "chars": _progress.get("chars", 0), "units": _progress.get("units", 0),
                          "tracks": _progress.get("tracks", [])}
    return {**st, "plan": profile.key(), "has_api_key": has_api_key()}


def _set(st: dict) -> None:
    db.kv_set("onboarding", st)
    bus.publish("onboarding", {"status": st.get("status")})


def start(answers: dict, change: str = "") -> dict:
    """Starts writing a draft (or a changed draft). Returns at once; the job reports through kv 'onboarding'."""
    if not has_api_key():
        raise state.Refused("Set up an AI provider first (Settings → AI providers): the plan is drafted by the model.")
    if "draft" in _running:
        raise state.Refused("A draft is being written already.")
    old = db.kv_get("onboarding", None) or {}
    if change:
        if not old.get("draft") or not old.get("answers_full"):
            raise state.Refused("There is no draft to change yet.")
        a = old["answers_full"]
        change = _s(change, 2000)
        if not change:
            raise state.Refused("Say what to change.")
    else:
        a = clean_answers(answers)
    _set({"status": "drafting", "answers": {k: v for k, v in a.items() if k != "plan_text"}, "answers_full": a,
          "draft": old.get("draft") if change else None, "change": change, "started": db.ts()})
    return status()


async def run() -> None:
    st = db.kv_get("onboarding", None) or {}
    if st.get("status") != "drafting" or "draft" in _running:
        return
    _running.add("draft")
    _progress.clear()
    _progress.update(phase="thinking", t0=time.monotonic(), chars=0, units=0, tracks=[])
    written: list[str] = []

    def on(kind: str, val) -> None:
        if kind != "text":
            return
        written.append(val)
        _progress["phase"] = "writing"
        _progress["chars"] += len(val)
        if len(written) % 16 == 0:
            _scan("".join(written))

    try:
        a = st["answers_full"]
        earlier = _model_view(st["draft"]["plan"]) if st.get("change") and st.get("draft") else None
        raw = await llm.structured_live(DRAFT_SYSTEM, _prompt(a, earlier, st.get("change") or ""), DRAFT_SCHEMA, on,
                                        effort="high", max_tokens=48000)
        _scan("".join(written))
        _progress["phase"] = "checking"
        a, coded = _programming(raw, a, st.get("change") or "")
        plan, notes = normalize(raw, a)
        _keep_removed(plan, (st.get("draft") or {}).get("plan") if st.get("change") else None)
        notes = coded + notes
        notes += await asyncio.to_thread(check_links, plan)
        st = {**st, "answers_full": a, "answers": {k: v for k, v in a.items() if k != "plan_text"}}
        _set({**st, "status": "ready", "draft": {"plan": plan, "notes": notes, "at": db.ts()}, "error": None})
    except Exception as e:  # noqa: BLE001 - shown to the user, who can try again
        log.exception("onboarding draft failed")
        msg = str(e) if isinstance(e, state.Refused) else f"The draft could not be written: {e}"
        _set({**st, "status": "failed", "error": msg[:600]})
    finally:
        _running.discard("draft")
        _progress.clear()


def _model_view(plan: dict) -> dict:
    """The parts of a plan the model wrote, for a change request."""
    return {k: plan.get(k) for k in ("label", "summary", "tracks", "goals", "roadmap")} | {
        "week": [{"weekday": i, "blocks": [{"start": b["start"], "end": b["end"], "track": b["kind"], "title": b["title"]}
                                           for b in day]} for i, day in enumerate(plan["week"]) if day],
        "unit_pass": plan["thresholds"]["unit_quiz"]["threshold"]}


def discard() -> dict:
    if "draft" in _running:
        raise state.Refused("Wait until the draft is written.")
    db.kv_set("onboarding", {"status": "idle"})
    bus.publish("onboarding", {"status": "idle"})
    return status()


def approve(confirm: bool) -> dict:
    """The user approved the draft: it becomes the plan. A copy of the database is kept first. Days already worked on
    stay as they are; days ahead that nobody touched are planned again from the new plan."""
    st = db.kv_get("onboarding", None) or {}
    draft = (st.get("draft") or {}).get("plan")
    if st.get("status") != "ready" or not draft:
        raise state.Refused("There is no finished draft to approve.")
    if not confirm:
        raise state.Refused("Approving replaces the plan; confirm it.")
    from . import planner
    if planner._lock.locked():
        raise state.Refused("The app is planning days right now. Try again in a minute.")
    had = profile.key()
    if db.q1("SELECT 1 FROM days LIMIT 1"):
        db.backup(f"before-plan-{db.ts()[:19].replace(':', '')}")
    plan = {**draft, "approved_at": db.ts()}
    start = date.fromisoformat(plan["start_date"])
    with db.tx():
        db.kv_set("plan", plan)
        db.ex("UPDATE profile SET preset='custom', updated_at=? WHERE id=1", (db.ts(),))
        db.kv_set("track_cursor", {})
        for d in db.q("SELECT date FROM days WHERE status='planned' AND date>=?", (today().isoformat(),)):
            if not planner.touched(d["date"]):
                db.ex("DELETE FROM tasks WHERE date=?", (d["date"],))
                db.ex("DELETE FROM blocks WHERE date=?", (d["date"],))
                db.ex("DELETE FROM days WHERE date=?", (d["date"],))
        # one-off study days ahead copy a weekday of the old plan: they go unless worked on already
        extra = profile.extra_days()
        keep = {k: v for k, v in extra.items() if k < today().isoformat() or db.q1("SELECT 1 FROM days WHERE date=?", (k,))}
        if keep != extra:
            db.kv_set("extra_days", keep)
        language = (plan.get("answers") or {}).get("language")
        if language in ("tr", "en"):
            from . import coach
            s = coach.settings()
            if s.get("language") == "auto":
                db.kv_set("coach_settings", {**s, "language": language})
        db.kv_set("onboarding", {"status": "idle"})
    profile.reload()
    health.clear_prefix("runway_")
    planlog.add(("Plan approved" if had != "custom" else "Plan change approved") + f": {plan['label']}. Starts "
                f"{start.isoformat()}; " + "; ".join(f"{t['label']} ({sum(1 for u in t['units'] if not u.get('skip'))} units)"
                                         for t in plan["tracks"]) +
                ".", "Plan")
    planlog.write()
    bus.publish("plan", {"approved": True})
    return status()

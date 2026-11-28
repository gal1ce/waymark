"""The in-app coach: chat with tools over the program state, with the
no-solutions / 30-minute rule enforced both in the prompt and on the output."""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
import re
from datetime import date, timedelta
from pathlib import Path

from . import bus, db, llm, practice, profile, prompts, providers, state
from .config import (COACH_MD, KINTSUGI, NO_HINT_BEFORE_MIN, PLAN_PDF_TEXT, STUDY_REPO, now, today)

log = logging.getLogger(__name__)

TOOLS = [
    {"name": "get_day", "description": "A day's blocks, tasks, times, compile status, scores and sticking points. Today if date is empty.",
     "input_schema": {"type": "object", "properties": {"date": {"type": "string", "description": "YYYY-MM-DD, empty = today"}},
                      "required": [], "additionalProperties": False}},
    {"name": "get_history", "description": "Summary of the last N days: done/total tasks, scores, test result, sticking points.",
     "input_schema": {"type": "object", "properties": {"days": {"type": "integer"}}, "required": ["days"], "additionalProperties": False}},
    {"name": "read_file", "description": "Read a file. scope: repo (~/quaimlres_road), coach (COACH.md, empty path), kintsugi (project source), plan (text of the PDF plan, empty path).",
     "input_schema": {"type": "object", "properties": {"scope": {"type": "string", "enum": ["repo", "coach", "kintsugi", "plan"]},
                                                       "path": {"type": "string"}},
                      "required": ["scope", "path"], "additionalProperties": False}},
    {"name": "list_files", "description": "List a folder (repo or kintsugi).",
     "input_schema": {"type": "object", "properties": {"scope": {"type": "string", "enum": ["repo", "kintsugi"]},
                                                       "path": {"type": "string"}},
                      "required": ["scope", "path"], "additionalProperties": False}},
    {"name": "add_stuck_point", "description": "Record a sticking point.",
     "input_schema": {"type": "object", "properties": {"summary": {"type": "string"}, "task_id": {"type": "integer", "description": "0 if unknown"}},
                      "required": ["summary", "task_id"], "additionalProperties": False}},
    {"name": "resolve_stuck_point", "description": "Close a sticking point the user got past.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"], "additionalProperties": False}},
    {"name": "add_day_note", "description": "Append to today's notes; they go into PROGRESS.md when the day closes.",
     "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}},
    {"name": "append_coach_log", "description": "Append a line to the weekly log in COACH.md (append only; doesn't change thresholds or the schedule).",
     "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}},
    {"name": "update_future_day", "description": "Rewrite the tasks of a locked (future) day. Blocks/times are fixed. Describe what to change and how in 'instructions'; the planner applies it.",
     "input_schema": {"type": "object", "properties": {"date": {"type": "string"}, "instructions": {"type": "string"}},
                      "required": ["date", "instructions"], "additionalProperties": False}},
    {"name": "create_practice_test", "description": "Create one timed practice test on the app's Tests page (not scored, not a sticking point source) and wait until its questions are written. Use whenever the user asks for a test or quiz; call it once per test when they ask for several. Also use it instead of sending the user to find exercises in a book or on another site: when they need problems to practise, the app writes and checks them. Returns whether it is ready, and its link.",
     "input_schema": {"type": "object", "properties": {"topics": {"type": "string", "description": "e.g. 'math (algebra foundations), C (variables)'; empty = what the user studied recently"},
                                                       "count": {"type": "integer", "description": "number of questions, 3-15; 0 = default (6, or the same as the follow-up's base test)"},
                                                       "difficulty": {"type": "string", "enum": ["auto", "easy", "medium", "hard", "harder", "easier"],
                                                                      "description": "auto = chosen from the user's recent practice results; harder/easier = relative to the follow_of test"},
                                                       "follow_of": {"type": "integer", "description": "id of an earlier test this one follows up on (its questions are not repeated, its mistakes get more weight); 0 = none"}},
                      "required": ["topics", "count", "difficulty", "follow_of"], "additionalProperties": False}},
    {"name": "get_test", "description": "One test question by question: the question, the user's answer, the right answer, the explanation, "
                                        "seconds spent and how often the answer was changed. Use it whenever the user talks about a test or a question "
                                        "number (\"I couldn't do 4 and 5\"): you never need to ask them which ones they got wrong.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer", "description": "test id; 0 = the user's most recent test"}},
                      "required": ["id"], "additionalProperties": False}},
    {"name": "get_activity", "description": "What the user did, in order: tasks started, paused and finished, tests started, paused and submitted (with the wrong questions), files saved, compiles, commits, reading. For spotting patterns: when they work, what they skip, where time goes.",
     "input_schema": {"type": "object", "properties": {"days": {"type": "integer", "description": "1 = today only, at most 14"}},
                      "required": ["days"], "additionalProperties": False}},
    {"name": "remember", "description": "Save a memory note about the user (a fact or preference, in English, one sentence). Only when the user explicitly asks you to remember something. The user can see, edit and delete notes in the coach settings.",
     "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}},
]



def tools() -> list[dict]:
    """The coach's tools for the active plan. A custom plan has no COACH.md, Kintsugi or PDF plan: its plan file is
    PLAN.md (written by the app) and its files are in the study folder."""
    if profile.is_ctu():
        return TOOLS
    out = json.loads(json.dumps(TOOLS))
    for t in out:
        props = t["input_schema"]["properties"]
        if t["name"] == "read_file":
            t["description"] = ("Read a file. scope: repo (the user's study folder), plan (PLAN.md: the approved plan, "
                                "its tracks and its log; empty path).")
            props["scope"]["enum"] = ["repo", "plan"]
        elif t["name"] == "list_files":
            t["description"] = "List a folder of the user's study folder."
            props["scope"]["enum"] = ["repo"]
        elif t["name"] == "add_day_note":
            t["description"] = "Append to today's notes (kept with the day; shown in its record)."
        elif t["name"] == "append_coach_log":
            t["description"] = "Append a line to the plan's log in PLAN.md (append only; doesn't change the plan)."
    return out


TOOL_LABEL = {
    "web_search": "Searching the web",
    "get_day": "Looking at your day", "get_history": "Reading your recent days", "read_file": "Reading a file",
    "list_files": "Browsing files", "add_stuck_point": "Logging a sticking point", "resolve_stuck_point": "Closing a sticking point",
    "add_day_note": "Adding a day note", "append_coach_log": "Writing to the coach log", "update_future_day": "Re-planning a future day",
    "remember": "Saving a memory note", "create_practice_test": "Creating a practice test", "get_test": "Reading your test",
    "get_activity": "Reading what you did",
}


def tool_label(name: str, args: dict | None = None) -> str:
    a = args or {}
    if name == "read_file":
        return {"coach": "Reading COACH.md", "plan": "Reading the plan"}.get(a.get("scope"), f"Reading {a.get('path') or 'a file'}")
    if name == "list_files":
        return f"Browsing {a.get('scope', 'repo')}/{a.get('path', '')}".rstrip("/")
    if name == "get_day" and a.get("date"):
        return f"Looking at {a['date']}"
    if name == "get_history" and a.get("days"):
        return f"Reading the last {a['days']} days"
    if name == "update_future_day" and a.get("date"):
        return f"Re-planning {a['date']}"
    if name == "get_test" and a.get("id"):
        return f"Reading test #{a['id']}"
    return TOOL_LABEL.get(name, name)


MAX_READ = 60_000


def _safe(base: Path, rel: str) -> Path:
    p = (base / rel).resolve()
    if base.resolve() not in (p, *p.parents):
        raise state.Refused("This path is outside the allowed folders.")
    return p


def _history_day(ds: str) -> dict:
    tasks = db.q("SELECT title,status,est_min,spent_sec FROM tasks WHERE date=?", (ds,))
    return {
        "date": ds,
        "done": sum(t["status"] == "done" for t in tasks), "total": len(tasks),
        "spent_min": sum(t["spent_sec"] for t in tasks) // 60,
        "unfinished": [t["title"] for t in tasks if t["status"] != "done"],
        "scores": db.q("SELECT kind,item,value,max,threshold,passed FROM scores WHERE date=?", (ds,)),
        "test": db.q1("SELECT score,max,status FROM tests WHERE date=? ORDER BY id DESC LIMIT 1", (ds,)),
        "stuck": [s["summary"] for s in db.q("SELECT summary FROM stuck WHERE date=?", (ds,))],
    }


def _history(days: int) -> list[dict]:
    end = today()
    return [_history_day(r["date"]) for r in db.q("SELECT date FROM days WHERE date<=? AND date>=? ORDER BY date",
                                                  (end.isoformat(), (end - timedelta(days=max(1, min(days, 60)))).isoformat()))]


async def run_tool(name: str, args: dict) -> str:
    if name == "get_day":
        ds = args.get("date") or today().isoformat()
        return json.dumps(state.get_day(ds, reveal=True), ensure_ascii=False, default=str)[:MAX_READ]
    if name == "get_history":
        return json.dumps(_history(int(args.get("days", 7))), ensure_ascii=False, default=str)[:MAX_READ]
    if name == "read_file":
        scope, path = args["scope"], args.get("path", "")
        if not profile.is_ctu():
            if scope == "plan":
                from . import planlog
                p = planlog.write() or planlog.path()
                return p.read_text(errors="replace")[:MAX_READ] if p.is_file() else "There is no plan yet."
            if scope != "repo":
                return "That scope isn't part of this plan."
        if scope == "coach":
            p = COACH_MD
        elif scope == "plan":
            p = PLAN_PDF_TEXT
        else:
            p = _safe(STUDY_REPO if scope == "repo" else KINTSUGI, path)
        if not p.is_file():
            return f"No such file: {path}"
        return p.read_text(errors="replace")[:MAX_READ]
    if name == "list_files":
        if args["scope"] != "repo" and not profile.is_ctu():
            return "That scope isn't part of this plan."
        base = STUDY_REPO if args["scope"] == "repo" else KINTSUGI
        p = _safe(base, args.get("path", ""))
        if not p.is_dir():
            return "No such folder."
        items = sorted(x.name + ("/" if x.is_dir() else "") for x in p.iterdir() if not x.name.startswith(".git"))
        return "\n".join(items[:300])
    if name == "add_stuck_point":
        sid = state.add_stuck("agent", args["summary"], args.get("task_id") or None, dedupe_min=5)
        return f"recorded #{sid}" if sid else "the same one is already open"
    if name == "resolve_stuck_point":
        state.resolve_stuck(int(args["id"]))
        return "closed"
    if name == "add_day_note":
        ds = today().isoformat()
        if not state.add_day_note(ds, args["text"]):
            return "No plan today."
        return "appended"
    if name == "append_coach_log":
        from .planner import append_coach_log
        return "appended" if append_coach_log(args["text"]) else "COACH.md was not found; nothing was written."
    if name == "update_future_day":
        from .planner import adapt_day
        ds = args["date"]
        if date.fromisoformat(ds) <= today():
            return "Only future (locked) days can be changed."
        if not db.q1("SELECT 1 FROM days WHERE date=?", (ds,)):
            return "That day hasn't been created yet."
        if not await adapt_day(ds, extra_instructions=args["instructions"]):
            return "Not changed: work has already started on that day."
        return "updated"
    if name == "create_practice_test":
        turn = _turn_tests.get()
        if turn and turn["router"]:
            # the app already made what this message asked for: never a second copy
            return "The app already created the tests for this message:\n" + tests_report(list(turn["ids"].values()))
        diff = str(args.get("difficulty") or "auto")
        ref = int(args.get("follow_of") or 0) or None
        it = practice.Intent(topics=practice.topics_in(args.get("topics", "")), label=str(args.get("topics") or "").strip(),
                             count=int(args.get("count") or 0) or None, level=diff if diff in practice.LEVELS else None,
                             shift={"harder": 1, "easier": -1}.get(diff, 0), ref=ref or ("last" if diff in ("harder", "easier") else None))
        spec = practice.resolve(it, turn["convo"] if turn else None)
        tid = make_practice_test(spec)
        return f"Created practice test #{tid} (link #/test/{tid})."
    if name == "get_test":
        tid = int(args.get("id") or 0)
        t = (db.q1("SELECT id FROM tests WHERE id=?", (tid,)) if tid else
             db.q1("SELECT id FROM tests WHERE status!='failed' ORDER BY COALESCE(submitted_at, started_at, created_at) DESC LIMIT 1"))
        return test_detail(t["id"]) if t else "No such test."
    if name == "get_activity":
        return activity(int(args.get("days") or 1))
    if name == "remember":
        from . import coach
        nid = coach.add_memory(args["text"])
        bus.publish("coach", {"memory": nid})
        return f"saved note #{nid}"
    return f"Unknown tool: {name}"


def _test_title(t: dict) -> str:
    kind = {"practice": "practice test", "eod": "end-of-day test", "c_quiz": "C quiz", "unit_quiz": "unit check"}.get(t["kind"], t["kind"])
    topics = practice.spec_of(t["id"]).get("topics") if t["kind"] == "practice" else ""
    return f"#{t['id']} {kind}" + (f" on {topics}" if topics else "") + f" ({t['date']})"


def _q_text(q: dict, n: int = 220) -> str:
    body = " ".join(x for x in (q.get("prompt", ""), f"${q['math']}$" if q.get("math") else "",
                                (q.get("code") or "").replace("\n", " ")[:160]) if x)
    return body[:n]


def test_detail(tid: int) -> str:
    """A test question by question, with the user's answers once it is submitted (for get_test)."""
    from . import tests_eod
    t = db.decode(db.q1("SELECT * FROM tests WHERE id=?", (tid,)))
    if not t:
        return "No such test."
    head = _test_title(t) + f": {t['status']}"
    if t["status"] == "submitted":
        head += f", score {t['score']:g}/{t['max']:g}" + (" (cancelled)" if t.get("cancelled") else "")
    trace = tests_eod.trace_of(tid)
    res = {r["id"]: r for r in t["results"] or []}
    lines = [head, f"Link: [Test #{tid}](#/test/{tid})"]
    for n, q in enumerate(t["questions"] or [], 1):
        r, tr = res.get(q["id"]), trace.get(q["id"]) or {}
        line = f"Q{n} [{q.get('topic', '')}, {q['type']}] {_q_text(q, 400)}"
        if q.get("choices"):
            line += " | choices: " + " / ".join(q["choices"])
        if r:
            verdict = "VOID (taken out)" if r.get("void") else "correct" if r["correct"] else "WRONG" if str(r["given"]).strip() else "EMPTY"
            line += f"\n   user: {r['given'] or '(empty)'} → {verdict}; right answer: {r['answer']}"
            if r.get("explanation"):
                line += f"; why: {r['explanation'][:300]}"
        elif t["status"] == "in_progress":
            line += "\n   (test running: answers hidden)"
        if tr.get("sec"):
            line += f"\n   {tr['sec']} s on it" + (f", answer changed {tr['changes']}x" if tr.get("changes") else "")
        lines.append(line)
    return "\n".join(lines)


def activity(days: int) -> str:
    """The event log of the last days, one line each, for get_activity."""
    days = max(1, min(days, 14))
    rows = db.q("SELECT e.ts, e.type, e.data, t.title FROM events e LEFT JOIN tasks t ON t.id = e.task_id "
                "WHERE e.date>=? ORDER BY e.id", ((today() - timedelta(days=days - 1)).isoformat(),))
    if not rows:
        return "Nothing recorded in that time."
    out = []
    for r in rows[-400:]:
        d = json.loads(r["data"] or "{}")
        d.pop("stdout", None), d.pop("stderr", None)
        extra = json.dumps(d, ensure_ascii=False)[:200] if d else ""
        out.append(f"{r['ts'][:16].replace('T', ' ')} {r['type']}" + (f" · {r['title']}" if r["title"] else "") + (f" {extra}" if extra else ""))
    return "\n".join(out)[-MAX_READ:]


def _recent_tests_block() -> str:
    """The last few tests with what went wrong in each, so "I couldn't do 4 and 5" needs no question back."""
    cut = (today() - timedelta(days=3)).isoformat()
    rows = db.q("SELECT * FROM tests WHERE status IN ('submitted','in_progress','ready') AND date>=? AND cancelled=0 "
                "ORDER BY id DESC LIMIT 5", (cut,))
    if not rows:
        return ""
    from . import tests_eod
    out = ["Recent tests (newest first; question numbers are the ones the user sees):"]
    for t in map(db.decode, rows):
        if t["status"] != "submitted":
            st = "in progress" if t["status"] == "in_progress" else "paused" if t.get("used_sec") else "not started"
            out.append(f"- {_test_title(t)}: {st}, {len(t['questions'] or [])} questions (#/test/{t['id']})")
            continue
        trace = tests_eod.trace_of(t["id"])
        res = {r["id"]: r for r in t["results"] or []}
        out.append(f"- {_test_title(t)}: {t['score']:g}/{t['max']:g} (#/test/{t['id']})")
        for n, q in enumerate(t["questions"] or [], 1):
            r = res.get(q["id"])
            if not r or r.get("void"):
                continue
            sec = (trace.get(q["id"]) or {}).get("sec")
            tm = f", {sec} s" if sec else ""
            if r["correct"]:
                out.append(f"  Q{n} [{q.get('topic', '')}] correct{tm}")
            else:
                out.append(f"  Q{n} [{q.get('topic', '')}] {'WRONG' if str(r['given']).strip() else 'EMPTY'}{tm}: {_q_text(q, 160)}"
                           f" | user: {r['given'] or '-'} | right: {r['answer']}")
    out.append("For a whole question with its explanation, call get_test.")
    return "\n".join(out)


_bg: set[asyncio.Task] = set()


# What this chat turn already created: {"router": the app made them, "ids": {spec key: test id}, "convo": id}.
# Asking again for the same thing in one turn returns the same test; a new message always gets new tests.
_turn_tests: contextvars.ContextVar[dict | None] = contextvars.ContextVar("turn_tests", default=None)
_fills: dict[int, asyncio.Task] = {}
WAIT_MAX = 300   # seconds the chat waits for a test's questions before answering anyway


def make_practice_test(spec: dict, copy: int = 0) -> int:
    """Create a practice test and write its questions in the background; once per spec per chat turn, at most 3."""
    from . import tests_eod
    turn = _turn_tests.get()
    k = practice.key(spec, copy)
    if turn is not None:
        if k in turn["ids"]:
            return turn["ids"][k]
        if len(turn["ids"]) >= practice.MAX_PER_TURN:
            raise state.Refused(f"At most {practice.MAX_PER_TURN} tests per message.")
    tid = tests_eod.create_practice(spec)
    if turn is not None:
        turn["ids"][k] = tid
    t = asyncio.get_running_loop().create_task(tests_eod.fill(tid))
    _fills[tid] = t
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    t.add_done_callback(lambda _t, i=tid: _fills.pop(i, None))
    return tid


def tests_report(ids: list[int]) -> str:
    """Where each test stands, for the model to tell the user."""
    out = []
    for tid in ids:
        t = db.q1("SELECT status,error,questions,time_limit_min FROM tests WHERE id=?", (tid,))
        sp = practice.spec_of(tid)
        if not t:
            continue
        what = f"{sp.get('topics') or 'recent topics'}, {sp.get('level') or 'medium'} level"
        if t["status"] == "ready":
            n = len(json.loads(t["questions"] or "[]"))
            note = practice.count_note(sp)
            short = n < sp.get("count", n)
            out.append(f"- #{tid} READY: {n} questions on {what}, {t['time_limit_min']} min"
                       + (f"; {note}" if note else "") + (f"; {sp['count'] - n} dropped by the app's checks" if short else "")
                       + (f"; follow-up to #{sp['follow_of']}" if sp.get("follow_of") else "") + f". Link: [Practice test #{tid}](#/test/{tid})")
        elif t["status"] == "failed":
            out.append(f"- #{tid} FAILED: {t['error']}. The user can press Try again on [the test page](#/test/{tid}).")
        else:
            out.append(f"- #{tid} still being written (taking longer than usual); it shows up on [the test page](#/test/{tid}) when done.")
    return "\n".join(out)


async def _follow_tests(ids: list[int]):
    """Stream events while the tests' questions are written: one card per test, then a heartbeat until all are done."""
    from . import tests_eod
    for tid in ids:
        yield {"type": "test", "id": tid, "live": tests_eod.live(tid)}
    label = "Writing practice test " + ", ".join(f"#{i}" for i in ids)
    pending = {_fills[i] for i in ids if i in _fills}
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    while pending and loop.time() - t0 < WAIT_MAX:
        yield {"type": "status", "phase": "running", "tool": "create_practice_test", "label": label}
        _, pending = await asyncio.wait(pending, timeout=4)


CODE_FENCE = re.compile(r"```[a-zA-Z0-9+]*\n(.*?)```", re.S)


def _guard(text: str, learning: bool) -> str:
    """Last line of defence for rule 1: drop multi-line code from replies while a learning task is open."""
    if not learning:
        return text

    def repl(m: re.Match) -> str:
        body = m.group(1).strip("\n")
        if len(body.splitlines()) <= 2 and len(body) < 120:
            return m.group(0)
        return "_[code removed: the coach doesn't write code on learning tasks]_"

    return CODE_FENCE.sub(repl, text)


_FOLLOW_TAG = "<followups>"
_FOLLOW_RE = re.compile(r"\s*<followups>(.*?)(?:</followups>|$)", re.S)


def split_followups(text: str) -> tuple[str, list[str]]:
    """The reply without its <followups> block, and the block's lines: replies the user may send next."""
    m = _FOLLOW_RE.search(text)
    if not m:
        return text, []
    items = []
    for line in m.group(1).splitlines():
        line = re.sub(r"^\s*(?:[-*\u2022]|\d+[.)])\s+", "", line).strip().strip('"').strip()
        if line and line not in items:
            items.append(line[:120])
    return (text[:m.start()] + text[m.end():]).rstrip(), items[:4]


def _hide_followups(text: str) -> str:
    """While streaming: never show the block, nor the start of its tag at the very end."""
    i = text.find("<followups")
    if i >= 0:
        return text[:i].rstrip()
    for k in range(len(_FOLLOW_TAG) - 1, 0, -1):
        if text.endswith(_FOLLOW_TAG[:k]):
            return text[:-k].rstrip()
    return text


def _status_block(task: dict | None) -> tuple[str, bool]:
    if not task:
        return ("[STATUS] No active task: the user has not started one (the day page says the same). Time: "
                + now().strftime("%H:%M") + "\nNever say a task or block is running, active or starting now. You may "
                "suggest the block scheduled at this time once in a conversation (\"the <track> block is "
                "scheduled now, start its task when you're ready\"), not at the end of every reply, and not while the "
                "user is working through something with you."), True
    mins = state.minutes_on_task(task["id"])
    learning = bool(task["learning"])
    meta = task.get("meta") or {}
    meta = json.loads(meta) if isinstance(meta, str) else meta
    early = meta.get("explain_early")
    hint_ok = (not learning) or mins >= NO_HINT_BEFORE_MIN or early is not None
    stuck = db.q("SELECT id,source,summary FROM stuck WHERE task_id=? AND resolved=0", (task["id"],))
    compile_ = task.get("compile")
    lines = [
        "[STATUS]",
        f"Time: {now().strftime('%H:%M')}",
        f"Active task #{task['id']}: {task['title']} (kind: {task['kind']}, estimated {task['est_min']} min)",
        f"Time spent on this task: {mins} min",
        f"Hints/concept explanations open: {'YES' if hint_ok else f'NO ({NO_HINT_BEFORE_MIN - mins} more min of own attempts)'}",
        f"Learning task (code/solutions forbidden): {'YES' if learning else 'NO'}",
    ]
    if early is not None and learning and mins < NO_HINT_BEFORE_MIN:
        lines.append(f"The user pressed \"Explain now\" at {early} min: explain the concept fully (definitions, why it works, a "
                     "worked example of a DIFFERENT problem), then hand the task back with one check question. Still never "
                     "their own exercise's solution or code.")
    if not hint_ok:
        lines.append(f"If you hold anything back, say what you CAN do now, not what is closed: e.g. \"For now I'll guide you with "
                     f"questions and point you to the source; I can explain the concept in {NO_HINT_BEFORE_MIN - mins} min.\" "
                     "Never write \"your hints aren't open\": guiding questions are the help this stage gives.")
    res = [r for r in task.get("resources") or [] if r.get("href") or r.get("kind") == "kintsugi"]
    if res:
        lines.append("Links for this task: " + "; ".join(
            f"{r['label']} → {r['href'] if r.get('href') else '#/read/' + r['path']}" for r in res))
    if compile_:
        lines.append(f"Last compile: {compile_['type']} {json.dumps(compile_.get('data', {}), ensure_ascii=False)[:800]}")
    if stuck:
        lines.append("Open sticking points: " + "; ".join(f"#{s['id']} {s['summary']}" for s in stuck))
    return "\n".join(lines), learning


def _link(r: dict) -> str | None:
    if r.get("href"):
        return r["href"]
    if r.get("kind") == "kintsugi" and r.get("path"):
        return "#/read/" + r["path"]
    return None


def _task_line(t: dict, cur: dict | None) -> str:
    spent, est = t["spent_sec_live"] // 60, t["est_min"]
    if t["status"] == "done":
        st = "done"
    elif cur and t["id"] == cur["id"]:
        st = "DOING NOW"
    elif spent:
        st = f"started, paused (~{max(est - spent, 0)} min left of estimate)"
    else:
        st = "not started"
    line = f"  #{t['id']} {t['title']} [{t['kind']}{', learning' if t['learning'] else ''}] {st}; {spent}/{est} min"
    sc = t.get("score")
    if sc:
        line += (f"; score {sc['value']:g}/{sc['max']:g} (threshold {sc['threshold']:g}: "
                 f"{'passed' if sc['passed'] else 'BELOW threshold, not learned'})")
    return line


def _today_block() -> str:
    """Compact snapshot of today, injected every turn so most questions need no tool call.
    Only today and past days: future (locked) days are never shown here."""
    n, ds = now(), today().isoformat()
    day = state.get_day(ds)
    head = f"[TODAY] {ds} {day['weekday']}, week {profile.week_no(day['week'])}, time {n.strftime('%H:%M')}. App link: #/day/{ds}"
    if day["status"] == "off":
        return head + "\nNo study today (Thursday/Friday are off)."
    if not day.get("exists"):
        return head + "\nNo plan has been created for today yet."
    cur = state.current_task()
    hm = n.strftime("%H:%M")
    lines = [head + (" (day closed)" if day["status"] == "closed" else "")]
    p = day["progress"]
    left = [t for b in day["blocks"] for t in b["tasks"] if t["status"] != "done"]
    lines.append(f"Progress: {p['done']}/{p['total']} tasks done, {len(left)} left; "
                 f"{p['est_done_min']}/{p['est_total_min']} estimated min done; {p['spent_sec'] // 60} min tracked.")
    nxt = next((t for t in left if t["status"] != "done" and (not cur or t["id"] != cur["id"])), None)
    if cur:
        lines.append(f"Current task: #{cur['id']} {cur['title']}.")
    if nxt:
        lines.append(f"Next suggested task: #{nxt['id']} {nxt['title']}.")
    lines.append("Blocks:")
    for b in day["blocks"]:
        mark = ("" if not b["start"] <= hm < b["end"] else
                " <- scheduled now by the clock" + ("" if cur and any(t["id"] == cur["id"] for t in b["tasks"])
                                                     else " (no task started in it)"))
        lines.append(f"{b['start']}-{b['end']} {b['title']} ({b['kind']}){mark}")
        lines += [_task_line(t, cur) for t in b["tasks"]]
        links: dict[str, str] = {}
        for t in b["tasks"]:
            if t["status"] != "done":
                for r in t.get("resources") or []:
                    if (u := _link(r)) and u not in links.values():
                        links[r["label"]] = u
        if links:
            lines.append("  links: " + "; ".join(f"[{k}]({v})" for k, v in links.items()))
    # each one names the block its task sits in, so a score is never read as belonging to the block scheduled now
    stuck = db.q("SELECT s.id, s.summary, s.task_id, s.date, b.title AS block FROM stuck s LEFT JOIN tasks t ON t.id = s.task_id "
                 "LEFT JOIN blocks b ON b.id = t.block_id WHERE s.resolved=0 ORDER BY s.id DESC LIMIT 8")
    if stuck:
        lines.append("Open sticking points (each in its own subject; not about the block scheduled now unless it says so): " + "; ".join(
            f"#{s['id']} {s['summary']}" + (f" ({s['block']}, task #{s['task_id']}, {s['date']})" if s["block"]
                                             else f" (task #{s['task_id']})" if s["task_id"] else "") for s in stuck))
    recent = _recent_tests_block()
    if recent:
        lines.append(recent)
    if not db.q1("SELECT 1 FROM tests WHERE date=? AND kind='eod'", (ds,)):
        lines.append("End-of-day test: not yet; it is prepared in the evening block.")
    prev = db.q1("SELECT date FROM days WHERE date<? ORDER BY date DESC LIMIT 1", (ds,))
    if prev:
        h = _history_day(prev["date"])
        lines.append(f"Last study day {h['date']}: {h['done']}/{h['total']} done"
                     + (f", test {h['test']['score']}/{h['test']['max']}" if h["test"] and h["test"]["status"] == "submitted" else "")
                     + (f", unfinished: {', '.join(h['unfinished'][:4])}" if h["unfinished"] else "") + ".")
    try:
        from . import khan
        if brief := khan.coach_brief():
            lines.append(brief)
    except Exception as e:  # noqa: BLE001 - the snapshot must still go out
        log.warning("khan brief failed: %r", e)
    return "\n".join(lines)


MAX_TURNS = 30  # replay at most this many past turns of a conversation
_PLACEHOLDER = {"role": "assistant", "content": [{"type": "text", "text": "(no reply: deleted or interrupted)"}]}


def _blocks(c) -> list[dict]:
    return [{"type": "text", "text": c}] if isinstance(c, str) else list(c)


def _is_turn_start(m: dict) -> bool:
    return m["role"] == "user" and isinstance(m["content"], str)


def _sanitize(msgs: list[dict]) -> list[dict]:
    """Make stored rows a valid API conversation: status rows become user text, every tool_use has its
    tool_result (unpaired ones dropped), roles alternate, and a turn without a reply gets a placeholder."""
    rows = [{"role": "user" if m["role"] == "system" else m["role"], "content": m["content"],
             "_start": _is_turn_start(m)} for m in msgs]
    fixed: list[dict] = []
    for i, m in enumerate(rows):
        c = m["content"]
        if m["role"] == "assistant" and isinstance(c, list):
            ids = {b.get("id") for b in c if b.get("type") == "tool_use"}
            if ids:
                nxt = rows[i + 1] if i + 1 < len(rows) else None
                got = {b.get("tool_use_id") for b in nxt["content"]} if nxt and nxt["role"] == "user" and isinstance(nxt["content"], list) else set()
                if not ids <= got:
                    c = [b for b in c if b.get("type") != "tool_use"]
                    if not c:
                        continue
        if m["role"] == "user" and isinstance(c, list) and any(b.get("type") == "tool_result" for b in c):
            prev = fixed[-1] if fixed else None
            have = {b.get("id") for b in prev["content"] if b.get("type") == "tool_use"} if prev and prev["role"] == "assistant" else set()
            c = [b for b in c if b.get("type") != "tool_result" or b.get("tool_use_id") in have]
            if not c:
                continue
        if m["_start"] and fixed and fixed[-1]["role"] != "assistant":
            fixed.append({**_PLACEHOLDER, "_start": False})
        fixed.append({**m, "content": c})
    out: list[dict] = []
    for m in fixed:
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] = _blocks(out[-1]["content"]) + _blocks(m["content"])
        else:
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _history_messages(cid: int) -> list[dict]:
    rows = db.q("SELECT id, role, content, hidden, display FROM chat WHERE convo_id=? ORDER BY id", (cid,))
    starts = [r["id"] for r in rows if r["role"] == "user" and not r["hidden"] and r["display"]]
    first = starts[-MAX_TURNS] if len(starts) > MAX_TURNS else (starts[0] if starts else None)
    return [{"role": r["role"], "content": json.loads(r["content"])} for r in rows if first is not None and r["id"] >= first]


def _save(cid: int, role: str, content, display: str = "", task_id: int | None = None, hidden: bool = False,
          meta: dict | None = None) -> int:
    meta = {k: v for k, v in (meta or {}).items() if v}
    return db.ex("INSERT INTO chat(ts,date,role,content,display,task_id,hidden,convo_id,meta) VALUES(?,?,?,?,?,?,?,?,?)",
                 (db.ts(), today().isoformat(), role, json.dumps(content, ensure_ascii=False), display, task_id,
                  int(hidden), cid, json.dumps(meta, ensure_ascii=False) if meta else ""))


def chat_log(ds: str) -> list[dict]:
    """Back-compat: today's most recent conversation."""
    from . import coach
    cid = coach.default_convo()
    return coach.messages(cid) if cid else []


def _visible(text: str, learning: bool) -> str:
    """What can be shown of a partial reply: in learning mode hold back an unclosed code fence
    (it might be a solution) and trailing backticks that may start one."""
    if learning:
        if text.count("```") % 2:
            text = text[: text.rfind("```")]
        text = text.rstrip("`")
    return _guard(_hide_followups(text), learning)


def closed_book(asked: bool = False) -> bool:
    """A graded test is running: the client says so (a Khan unit test is open), or an end-of-day test is in its time."""
    from .tests_eod import active_exam
    return asked or bool(active_exam())


def prepare(convo_id: int | None, new: bool, closed: bool = False) -> int:
    """Checks that can fail before a stream starts; returns the conversation id to use.
    Closed book, questions go to a conversation of their own: the day's conversation has talked about past tests
    and their right answers, which a retake may ask again."""
    from . import coach
    if closed:
        c = coach.convo(convo_id) if convo_id and not new else None
        return c["id"] if c and c["title"] == coach.CLOSED_BOOK_TITLE else coach.create_convo(coach.CLOSED_BOOK_TITLE)
    if new:
        return coach.create_convo()
    if convo_id and coach.convo(convo_id):
        return convo_id
    # no id, or a stale one (deleted, or remembered by the browser from an older database): use today's
    # conversation; the stream's start event tells the client which id it ended up in
    return coach.default_convo() or coach.create_convo()


def _system() -> list[dict]:
    from . import coach
    return [{"type": "text", "text": prompts.coach_system()}, {"type": "text", "text": coach.style_block()}]


async def chat_events(user_text: str, cid: int, closed: bool = False):
    """One coach turn as a stream of events:
    start · status {phase: thinking|tool|running, label} · test {id, live} (a practice test being written; its progress
    arrives on the app's event stream) · delta {text} · replace {text} · done {reply, id} · error {message}
    Closed book (a graded test is running): a reference page only. No [TODAY] block (it holds past tests' right
    answers), no tools, no practice tests; the rules in prompts.CLOSED_BOOK."""
    from . import coach
    task = state.current_task()
    tid = task and task["id"]
    status, learning = _status_block(task)
    if closed:
        status += "\n\n" + prompts.CLOSED_BOOK
    history = _history_messages(cid)
    uid = _save(cid, "user", user_text, user_text, tid)
    _save(cid, "system", status, "", tid, hidden=True)
    coach.touch(cid, user_text)
    try:
        snapshot = "" if closed else _today_block()
    except Exception as e:  # noqa: BLE001 - the chat must still work
        snapshot = f"[TODAY] unavailable ({e!r}); use get_day."
    turn = {"router": False, "ids": {}, "convo": cid}
    _turn_tests.set(turn)
    made: list[int] = []
    fail = None
    for it in ([] if closed else practice.parse(user_text, history)):
        try:
            made.append(make_practice_test(practice.resolve(it, cid), it.copy))
        except Exception as e:  # noqa: BLE001 - the chat still answers
            fail = e
    turn["router"] = bool(made)
    max_tokens = coach.VERBOSITY_TOKENS[coach.settings()["verbosity"]] + 4000
    bus.publish("chat", {"state": "thinking", "convo": cid})
    yield {"type": "start", "convo_id": cid, "user_id": uid}
    texts: list[str] = []
    shown = ""
    finished = False
    # what the coach did on the way, in order; `at` is where in the shown text it happened, so the client can put
    # each step between the paragraphs written before and after it
    steps: list[dict] = []

    def step(tool: str, label: str) -> dict:
        steps.append({"tool": tool, "label": label, "at": len(shown), "state": "run"})
        return {"type": "step", "i": len(steps) - 1, **steps[-1]}

    def step_end(i: int, ok: bool = True) -> dict:
        steps[i]["state"] = "ok" if ok else "err"
        return {"type": "step", "i": i, **steps[i]}

    def open_steps():
        for i, x in enumerate(steps):
            if x["state"] == "run":
                yield step_end(i)

    def links() -> list[int]:  # every test made this turn, by the app or the tool
        return list(turn["ids"].values())

    def joined(extra: str = "") -> str:
        return "\n\n".join(t for t in [*texts, extra] if t.strip())

    try:
        if made:
            yield step("create_practice_test", "Writing practice test " + ", ".join(f"#{i}" for i in made))
            async for ev in _follow_tests(made):
                yield ev
            for ev in open_steps():
                yield ev
            status += ("\n[ACTION] The user asked for a practice test. The app created it and waited for its questions:\n"
                       + tests_report(made) + "\nTell the user in one or two sentences whether each is ready, with its link exactly "
                       "as given, its level and number of questions; if a count note is given, say it. If one failed, say so briefly. "
                       "Do NOT write questions in chat and do NOT call create_practice_test.")
        if fail:
            status += f"\n[ACTION] Creating {'another ' if made else 'a '}practice test failed: {fail}. Tell the user briefly."
        earlier = [m["content"] for m in history if _is_turn_start(m)]
        lang = coach.language_line(user_text, earlier)
        messages = _sanitize(history + [{"role": "user", "content": user_text},
                                        {"role": "system", "content": "\n\n".join(x for x in (status, snapshot, lang) if x)}])
        yield {"type": "status", "phase": "thinking"}
        for _ in range(8):
            buf, resp = "", None
            # a subscription may look current things up (cli.stream); never during a graded test (closed book)
            with contextlib.nullcontext() if closed else llm.web_search():
                async for kind, val in llm.stream(system=_system(), messages=messages, tools=None if closed else tools(), effort=coach.settings()["effort"],
                                                  max_tokens=max_tokens, role="chat"):
                    if kind == "restart":
                        # the provider broke off mid-reply; the next key or provider writes it again from the start
                        buf = ""
                        vis = _visible(joined(), learning)
                        yield {"type": "replace", "text": vis}
                        yield {"type": "status", "phase": "thinking", "label": val}
                        shown = vis
                    elif kind == "switch":
                        yield {"type": "status", "phase": "thinking", "label": f"Trying {val[1]}"}
                    elif kind == "text":
                        for ev in open_steps():   # a web search ends when the reply goes on
                            yield ev
                        buf += val
                        vis = _visible(joined(buf), learning)
                        if vis.startswith(shown):
                            if len(vis) > len(shown):
                                yield {"type": "delta", "text": vis[len(shown):]}
                        else:
                            yield {"type": "replace", "text": vis}
                        shown = vis
                    elif kind == "tool":
                        yield {"type": "status", "phase": "tool", "tool": val, "label": tool_label(val)}
                        if val == "web_search":   # runs on the provider's side: no "running" status follows
                            yield step(val, tool_label(val))
                    elif kind == "final":
                        resp = val
            for ev in open_steps():
                yield ev
            content = [b.to_dict() for b in resp.content]
            messages.append({"role": "assistant", "content": content})
            step_text = llm.text_of(resp)
            if resp.stop_reason == "refusal":
                final = "I can't answer this request."
                aid = _save(cid, "assistant", content, final, tid)
                finished = True
                yield {"type": "done", "reply": final, "id": aid, "convo_id": cid}
                return
            uses = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not uses:
                texts.append(step_text)
                body, followups = split_followups(joined())
                final = _guard(body, learning) or "(empty reply)"
                # whatever the model said, the link to every test it was asked for is always there
                miss = [i for i in links() if f"#/test/{i}" not in final]
                if miss:
                    final += "\n\n" + " · ".join(f"[Practice test #{i}](#/test/{i})" for i in miss)
                if resp.stop_reason == "max_tokens":
                    final += "\n\n_(cut off: reply hit the length limit)_"
                elif resp.stop_reason == "cut":
                    final += "\n\n_(the model stopped mid-reply, probably overloaded; send the question again)_"
                if getattr(resp, "provider", None) and resp.provider != providers.primary():
                    final += f"\n\n_(answered by {llm.label_of(resp)}: the main provider didn't answer)_"
                done_steps = [{k: x[k] for k in ("tool", "label", "at", "state")} for x in steps]
                aid = _save(cid, "assistant", content, final, tid, meta={"steps": done_steps, "followups": followups})
                finished = True
                yield {"type": "done", "reply": final, "id": aid, "convo_id": cid, "steps": done_steps, "followups": followups}
                return
            texts.append(step_text)
            _save(cid, "assistant", content, "", tid, hidden=True)
            results = []
            for u in uses:
                yield {"type": "status", "phase": "running", "tool": u.name, "label": tool_label(u.name, dict(u.input))}
                yield step(u.name, tool_label(u.name, dict(u.input)))
                ok = True
                try:
                    before = set(turn["ids"].values())
                    out = await run_tool(u.name, dict(u.input))
                    new = [i for i in turn["ids"].values() if i not in before]
                    if new:
                        # the model made a test itself: same live card, and the result says if it's ready
                        async for ev in _follow_tests(new):
                            yield ev
                        out = "Done waiting for the questions:\n" + tests_report(new) + "\nTell the user, with the link exactly as given."
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": out})
                except state.Refused as e:
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": str(e), "is_error": True})
                    ok = False
                except Exception as e:
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": f"Error: {e!r}", "is_error": True})
                    ok = False
                yield step_end(len(steps) - 1, ok)
            messages.append({"role": "user", "content": results})
            _save(cid, "user", results, "", tid, hidden=True)
            yield {"type": "status", "phase": "thinking"}
        final = "Too many tool calls. Can you ask a narrower question?"
        aid = _save(cid, "assistant", [{"type": "text", "text": final}], final)
        finished = True
        yield {"type": "done", "reply": final, "id": aid, "convo_id": cid}
    except (asyncio.CancelledError, GeneratorExit):
        # Stopped by the user (stream closed): keep what was already shown.
        if not finished:
            part = _guard(split_followups(joined())[0], learning).strip()
            if links():
                part = (part + "\n\n" if part else "") + " · ".join(f"[Practice test #{i}](#/test/{i})" for i in links())
            _save(cid, "assistant", [{"type": "text", "text": part or "(stopped)"}],
                  (part + "\n\n_(stopped)_") if part else "_(stopped)_", tid,
                  meta={"steps": [{**x, "state": "ok" if x["state"] == "ok" else "err"} for x in steps]})
            finished = True
        raise
    except Exception as e:
        # Keep the stored conversation valid so the next turn still works.
        msg = str(e) if isinstance(e, (llm.Unavailable, llm.NoKey)) else f"Couldn't reach the agent: {e}"
        _save(cid, "assistant", [{"type": "text", "text": "(connection error)"}], msg)
        finished = True
        yield {"type": "error", "message": msg}
    finally:
        coach.touch(cid)
        bus.publish("chat", {"state": "idle", "convo": cid})


async def chat(user_text: str, cid: int, closed: bool = False) -> str:
    """Non-streaming fallback: run the same turn and return the final reply."""
    async for ev in chat_events(user_text, cid, closed):
        if ev["type"] == "done":
            return ev["reply"]
        if ev["type"] == "error":
            raise RuntimeError(ev["message"])
    raise RuntimeError("The agent stopped without a reply.")

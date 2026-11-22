"""End-of-day tests and closed-book C quizzes: generation, timing, grading."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime

from . import bus, codecheck, db, llm, offline, practice, profile, prompts, state
from .config import STUDY_REPO, has_api_key, now, today

log = logging.getLogger("ctu.tests")
_running: set[int] = set()   # tests whose questions are being written right now
GRACE_SEC = 60               # a test past its limit by this much is submitted with the saved answers

Q_SCHEMA = llm.strict({
    "type": "object",
    "properties": {
        "questions": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["mcq", "output", "short"]},
                "topic": {"type": "string"},
                "prompt": {"type": "string"},
                "math": {"type": "string"},
                "code": {"type": "string"},
                "choices": {"type": "array", "items": {"type": "string"}},
                "answer": {"type": "string"},
                "accept": {"type": "array", "items": {"type": "string"}},
                "explanation": {"type": "string"},
                "answer_format": {"type": "string"},
            }}},
    }})

def create_practice(spec: dict, task_id: int | None = None) -> int:
    """A practice test the user asked for (spec from practice.resolve). Any day, any number of them; never scored.
    One made from a problem task (task_id) turns its wrong answers into sticking points of that task; one the coach
    made doesn't. Time: 2/3/4 min per question for easy/medium/hard, at least 10."""
    tid = db.ex("INSERT INTO tests(date,kind,task_id,status,source,created_at,time_limit_min) VALUES(?,?,?,?,?,?,?)",
                (today().isoformat(), "practice", task_id, "generating", "task" if task_id else "agent", db.ts(),
                 practice.minutes(spec)))
    db.kv_set(f"practice_spec_{tid}", spec)
    bus.publish("test", {"id": tid, "status": "generating"})
    return tid


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").strip().lower()).replace('"', "").replace("'", "")


def _day_context(ds: str) -> str:
    day = state.get_day(ds, reveal=True)
    parts = []
    for b in day.get("blocks", []):
        for t in b["tasks"]:
            if t["kind"] == "test":
                continue
            parts.append(f"- [{b['title']}] {t['title']} · status={t['status']} · {t['spent_sec_live'] // 60} min\n  {t['detail'][:400]}")
            for f in t["files"]:
                p = (STUDY_REPO / f).resolve()
                if STUDY_REPO.resolve() in p.parents and p.is_file() and t["status"] == "done":
                    parts.append(f"  User's file {f}:\n```\n{p.read_text(errors='replace')[:2500]}\n```")
    stuck = [f"- {s['summary']} ({s['source']})" for s in day.get("stuck", [])]
    scores = db.q("SELECT item,value,max FROM scores WHERE date=?", (ds,))
    return ("Tasks:\n" + "\n".join(parts) + "\n\nSticking points:\n" + ("\n".join(stuck) or "- none") +
            "\n\nScores:\n" + ("\n".join(f"- {s['item']}: {s['value']:g}/{s['max']:g}" for s in scores) or "- none"))


def create(ds: str, kind: str = "eod", task_id: int | None = None) -> int:
    state.require_active(ds)
    if kind == "unit_quiz":   # a day can hold several unit checks: one per task
        existing = db.q1("SELECT id FROM tests WHERE task_id=? AND kind=? AND status<>'failed' ORDER BY id DESC LIMIT 1",
                         (task_id, kind))
    else:
        existing = db.q1("SELECT id FROM tests WHERE date=? AND kind=? AND status<>'failed' ORDER BY id DESC LIMIT 1",
                         (ds, kind))
    if existing:
        return existing["id"]
    tid = db.ex("INSERT INTO tests(date,kind,task_id,status,source,created_at,time_limit_min) VALUES(?,?,?,?,?,?,?)",
                (ds, kind, task_id, "generating", "agent", db.ts(), {"c_quiz": 45, "unit_quiz": 15}.get(kind, 30)))
    bus.publish("test", {"id": tid, "status": "generating"})
    return tid


TYPE_LABEL = {"mcq": "multiple choice", "output": "code output", "short": "short answer"}
_LIVE: dict[int, dict] = {}   # test id → what generation is doing right now; shown on the test page


class _Live:
    """Narrates one generation: steps, the model in use, and each question's topic as it is written.
    Question text and answers are never sent, so watching doesn't spoil the test."""

    def __init__(self, tid: int):
        self.tid, self.t0, self.last, self.text, self.qs = tid, time.monotonic(), 0.0, "", 0
        self.d: dict = {"phase": "preparing", "model": None, "chars": 0, "log": []}
        _LIVE[tid] = self.d
        for old in sorted(_LIVE)[:-20]:
            _LIVE.pop(old, None)

    def elapsed(self) -> float:
        return round(time.monotonic() - self.t0, 1)

    def push(self, force: bool = False) -> None:
        n = time.monotonic()
        if force or n - self.last > 0.2:
            self.last = n
            self.d["elapsed"] = self.elapsed()
            bus.publish("test_progress", {"id": self.tid, **self.d})

    def log(self, text: str, kind: str = "step") -> None:
        self.d["log"].append({"t": self.elapsed(), "text": text, "kind": kind})
        self.push(force=True)

    def phase(self, p: str) -> None:
        self.d["phase"] = p
        self.push(force=True)

    def reset_text(self) -> None:
        self.text, self.qs, self.d["chars"] = "", 0, 0

    def on(self, kind: str, val) -> None:
        if kind == "model":
            self.d["model"] = val
            self.d["phase"] = "writing"
            self.log(f"Asking {val} to write the questions")
        elif kind == "switch":
            self.log(f"{val[0]} is out of free quota, switching to {val[1]}", "warn")
        elif kind == "text":
            if not self.text:
                self.log("First words arrived, writing")
            self.text += val
            self.d["chars"] = len(self.text)
            topics = re.findall(r'"topic"\s*:\s*"((?:[^"\\]|\\.)*)"', self.text)
            types = re.findall(r'"type"\s*:\s*"(mcq|output|short)"', self.text)
            while self.qs < len(topics):
                ty = types[self.qs] if self.qs < len(types) else ""
                self.qs += 1
                self.log(f"Question {self.qs} · {topics[self.qs - 1]}" + (f" · {TYPE_LABEL[ty]}" if ty else ""), "q")
            self.push()


def _polish(qs: list[dict], lv: "_Live") -> list[dict]:
    """Same result whatever model wrote it: code laid out by clang-format, 'what does it print' answers
    checked by actually running the code with gcc. Broken code is dropped instead of shown."""
    out = []
    for n, q in enumerate(qs, 1):
        code = q.get("code") or ""
        if code.strip():
            q["code"] = codecheck.fmt(code)
            if q["type"] == "output":
                st, val = codecheck.run(q["code"])
                if st == "ok":
                    if _norm(val) == _norm(q["answer"]):
                        lv.log(f"Question {n}: compiled and ran it with gcc, the expected output matches")
                    else:
                        lv.log(f"Question {n}: the model expected {q['answer']!r}, gcc printed {val.strip()!r}. Using gcc's output", "warn")
                        q["answer"], q["accept"] = val.rstrip("\n"), []
                elif st == "skip":
                    lv.log(f"Question {n}: not run ({val}), kept as written")
                else:
                    lv.log(f"Question {n}: dropped, the code {'does not compile' if st == 'compile' else 'fails when run'} ({val})", "warn")
                    continue
        if not q.get("math") and q["type"] != "mcq":
            # older/lazier output: "Solve for x: 3x - 4 = 11" → prompt + formula on its own line
            m = re.match(r"^(.*?):\s*([^:]*[=<>][^:]*)$", q["prompt"].strip())
            if m and len(m.group(2)) < 80:
                q["prompt"], q["math"] = _ask(m.group(1).strip()), m.group(2).strip()
        out.append(q)
    for n, q in enumerate(out, 1):
        q["id"] = f"q{n}"
    if not out:
        raise RuntimeError("Every question had broken code; nothing left to ask.")
    return out


async def _replace(system: str, prompt: str, qs: list[dict], kept: list[dict], lv: "_Live", effort: str) -> list[dict]:
    """One more try for the questions that were dropped: same request, told which ones to replace and why."""
    n = len(qs) - len(kept)
    lv.log(f"Asking for {n} replacement question{'s' if n > 1 else ''}")
    try:
        out = await llm.structured(system, f"{prompt}\n\nWrite exactly {n} question(s). These were rejected because "
                                   f"they leave out information they need, so do not repeat them:\n"
                                   + "\n".join(f"- {q['prompt']}" for q in qs if q not in kept)
                                   + "\nAlready in the test (do not repeat): " + " | ".join(q["prompt"] for q in kept),
                                   Q_SCHEMA, effort=effort)
        new = [q for q in out.get("questions", []) if _valid(q)][:n]
        for i, q in enumerate(new):
            q["id"] = f"r{i + 1}"
        new = await asyncio.to_thread(_polish, new, lv) if new else []
        for i, q in enumerate(new):
            q["id"] = f"r{i + 1}"
        new = await _check_complete(new, lv) if new else []
    except Exception as e:  # noqa: BLE001 - a shorter test beats no test
        lv.log(f"No replacement ({e}); the test is shorter", "warn")
        return []
    return new


def _ask(label: str) -> str:
    """Turn an exam label into a question: 'Solve for x' → 'What value of x makes this equation true?'"""
    if m := re.fullmatch(r"(?i)solve(?: for ([a-z]))?", label):
        return f"What value of {m.group(1) or 'x'} makes this equation true?"
    return {"evaluate": "What is the value of this expression?", "simplify": "What is this expression in its simplest form?",
            "factor": "How does this expression factor?", "compute": "What is the value of this expression?",
            "calculate": "What is the value of this expression?"}.get(label.lower(), label.rstrip(":"))


SELF_CONTAINED = ("Every question must be answerable from exactly what is shown with it: prompt, math, code and choices. "
                  "If it is about a function, equation, expression, matrix, table, graph or program, put that object in full "
                  "in math (or code), e.g. a piecewise function as f(x) = \\begin{cases} kx^2 & x < 2 \\\\ x + 4 & x \\ge 2 "
                  "\\end{cases}. Never write \"the function\" or \"this matrix\" without showing it; the explanation is "
                  "hidden until the test is submitted.")

# "the piecewise function", "this matrix", "the following table": an object the question needs, named but maybe not shown
_NEEDS = re.compile(r"(?i)\b(?:the|this|these|that|following|given|above|below)\s+(?:\w+\s+){0,2}?"
                    r"(?:function|functions|expression|equation|equations|graph|table|matrix|matrices|system|sequence|"
                    r"series|integral|limit|polynomial|figure|diagram|data|array|tree|program|code|snippet|statement|"
                    r"vectors?|set|relation|recurrence|algorithm|loop|proof|argument)\b")


def _maybe_incomplete(q: dict) -> bool:
    """Cheap first look: the question names an object (\"the piecewise function\") but shows no formula, code or
    worked-out definition. Only a hint; the model check decides."""
    if (q.get("math") or "").strip() or (q.get("code") or "").strip():
        return False
    text = q.get("prompt", "")
    if not _NEEDS.search(re.sub(r"\$[^$]*\$", " ", text)):
        return False
    # a definition inside the prompt itself, like $f(x) = 3x^2 - 1$ or a matrix
    return not any(len(m) >= 8 and ("=" in m or "\\begin" in m) for m in re.findall(r"\$([^$]+)\$", text))


CHECK_SCHEMA = llm.strict({"type": "object", "properties": {"missing": {"type": "array", "items": {
    "type": "object", "properties": {"id": {"type": "string"}, "why": {"type": "string"}}}}}})


async def _check_complete(qs: list[dict], lv: "_Live") -> list[dict]:
    """Drop any question a student can't answer from what the test screen shows (e.g. 'the piecewise function'
    with no function). A model reads each question exactly as shown; the cheap look above is the fallback."""
    shown = "\n\n".join(
        f"id={q['id']}\nPrompt: {q['prompt']}" + (f"\nMath: {q['math']}" if q.get("math") else "")
        + (f"\nCode:\n{q['code']}" if q.get("code") else "")
        + (f"\nChoices: {' | '.join(q.get('choices') or [])}" if q.get("choices") else "") for q in qs)
    bad: dict[str, str] = {}
    try:
        out = await llm.structured(
            "You check exam questions before a student sees them. For each question you get exactly what the test "
            "screen shows. List a question in missing only if information needed to answer it is absent from what is "
            "shown: a function, equation, matrix, table, graph, code or condition it refers to but does not give. "
            "Difficulty or style are not your concern. why: one short sentence.", shown, CHECK_SCHEMA, effort="low",
            max_tokens=4000)
        ids = {q["id"] for q in qs}
        bad = {m["id"]: m.get("why", "") for m in out.get("missing", []) if m.get("id") in ids}
    except Exception:  # noqa: BLE001 - no model check: fall back to the cheap look
        bad = {q["id"]: "it names something it doesn't show" for q in qs if _maybe_incomplete(q)}
    for q in qs:
        if q["id"] in bad:
            lv.log(f"Question {q['id'][1:]}: dropped, a student couldn't answer it from the screen ({bad[q['id']] or 'information missing'})", "warn")
    return [q for q in qs if q["id"] not in bad]


_Q_KEYS = ("id", "type", "prompt", "answer")


def _valid(q) -> bool:
    return isinstance(q, dict) and all(isinstance(q.get(k), str) and q[k].strip() for k in _Q_KEYS) \
        and q["type"] in TYPE_LABEL and (q["type"] != "mcq" or q["answer"] in (q.get("choices") or []))


def _salvage(text: str) -> list[dict]:
    """The complete question objects at the start of a reply that broke off mid-way."""
    i = text.find("[", text.find('"questions"'))
    if i < 0:
        return []
    dec, out, i = json.JSONDecoder(), [], i + 1
    while True:
        while i < len(text) and text[i] in " \t\r\n,":
            i += 1
        try:
            q, i = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            break
        if not _valid(q):
            break
        out.append(q)
    for n, q in enumerate(out, 1):
        q["id"] = f"q{n}"
    return out


def live(tid: int) -> dict | None:
    return _LIVE.get(tid)


def fail_interrupted() -> int:
    """At startup: a test left 'generating' by a stopped server will never finish; mark it failed so Retry works."""
    n = len(db.q("SELECT id FROM tests WHERE status='generating'"))
    db.ex("UPDATE tests SET status='failed', error='Interrupted: the server stopped while the questions were being "
          "written. Retry.' WHERE status='generating'")
    return n


def is_running(tid: int) -> bool:
    return tid in _running


async def fill(tid: int, chapters: str = "") -> None:
    if tid in _running:
        return
    _running.add(tid)
    try:
        await _fill(tid, chapters)
    finally:
        _running.discard(tid)


async def _fill(tid: int, chapters: str = "") -> None:
    t = db.q1("SELECT * FROM tests WHERE id=?", (tid,))
    if not t or t["status"] != "generating":
        return
    ds, kind = t["date"], t["kind"]
    lv = _Live(tid)
    try:
        if not has_api_key():
            lv.log("No API key: using the built-in question bank")
            fb = db.kv_get("fallback_tests", {}).get(ds) if kind == "eod" else None
            qs = fb or offline.build(ds, kind, chapters)
            if not qs:
                raise RuntimeError("No API key, and the built-in question bank has nothing for today's topics.")
            if not fb:
                lv.log(f"Picked {len(qs)} questions for " + ", ".join(sorted({q['topic'] for q in qs})))
            source = "fallback"
        else:
            if kind == "practice":
                spec = practice.spec_of(tid)
                level = spec.get("level") or "medium"
                lv.log(f"Practice on {spec.get('topics') or 'recent topics'}, {spec.get('count', 6)} questions, {level} level"
                       + (f" ({spec['level_why']})" if spec.get("level_why") else ""))
                study = db.q1("SELECT date FROM days WHERE date<=? ORDER BY date DESC LIMIT 1", (ds,))
                try:
                    recent = _day_context(study["date"]) if study else "(no study day yet)"
                    lv.log(f"Read your study day {study['date']} to match your level" if study else "No study day yet, starting from beginner")
                except Exception:  # noqa: BLE001 - no plan is fine for practice
                    recent = "(no study day yet)"
                    lv.log("No study day to read, starting from beginner")
                extra, notes = practice.brief(spec, tid)
                if spec.get("task"):
                    extra = (f"These problems replace a study-plan task the user may not have the book for. Write original "
                             f"problems of the same kind and level as it asks for, from easiest to hardest; never copy "
                             f"textbook exercises.\n{spec['task']}\n\n") + extra
                    lv.log("Read the problem task: same kind of problems, written fresh")
                for line in notes:
                    lv.log(line)
                system, prompt, effort = (prompts.practice_system(), f"Topics: {spec.get('topics') or 'what the user studied recently'}\n"
                                          f"Number of questions: {spec.get('count', 6)}\n\n{extra}\n\n"
                                          f"The user's latest study day:\n{recent}", "medium")
            elif kind == "unit_quiz":
                m = _task_meta(t["task_id"])
                tr = profile.track(m.get("track", ""))
                units = (tr or {}).get("units") or []
                u = units[m["unit"]] if isinstance(m.get("unit"), int) and m["unit"] < len(units) else None
                if not tr or not u:
                    raise RuntimeError("This unit check's unit isn't in the plan any more.")
                lv.log(f"Closed-book unit check on {tr['label']} · {u['title']}, 5 questions")
                system, effort = prompts.unit_quiz_system(), "high"
                prompt = (f"Track: {tr['label']}\nUnit: {u['title']}\nObjective: {u.get('objective', '')}\n"
                          f"Sources: {', '.join(r.get('label', '') for r in u.get('resources') or [])}\n\n"
                          f"The user's recent days:\n{_day_context(ds)}")
                lv.log("Read the unit's objective and today's work")
            elif kind == "c_quiz":
                lv.log(f"Closed-book quiz on Beej {chapters or 'recent chapters'}, 5 questions")
                system, prompt, effort = prompts.quiz_system(), f"Chapters: {chapters}\n\nThe user's recent days:\n{_day_context(ds)}", "high"
                lv.log("Read today's tasks, files and sticking points")
            else:
                system, prompt, effort = prompts.eod_system(), _day_context(ds), "high"
                lv.log("Read today's tasks, files and sticking points")
            prompt += "\n\n" + SELF_CONTAINED
            want = {"practice": (db.kv_get(f"practice_spec_{tid}", {}) or {}).get("count", 6), "c_quiz": 5, "unit_quiz": 5}.get(kind, 5)
            qs = []
            for attempt in (1, 2):
                try:
                    out = await llm.structured_live(system, prompt, Q_SCHEMA, lv.on, effort=effort)
                    qs = [q for q in out.get("questions", []) if _valid(q)][:15]
                    break
                except Exception as e:  # noqa: BLE001 - a broken-off or failed stream: keep what's complete, else ask once more
                    if "quota is used up" in str(e) or isinstance(e, llm.NoKey):
                        raise
                    got = _salvage(e.text if isinstance(e, llm.Truncated) else lv.text)
                    if len(got) >= max(3, want - 1) or (attempt == 2 and got):
                        lv.log(f"{e} Kept the {len(got)} complete questions", "warn")
                        qs = got
                        break
                    if attempt == 2:
                        raise
                    lv.log(f"{e} Asking again", "warn")
                    lv.reset_text()
            source = "agent"
        lv.phase("checking")
        lv.log(f"Checked the format: {len(qs)} questions with answers and explanations")
        if source == "agent":
            qs = await asyncio.to_thread(_polish, qs, lv)
            kept = await _check_complete(qs, lv)
            if len(kept) < len(qs):
                kept += await _replace(system, prompt, qs, kept, lv, effort)
                for n, q in enumerate(kept, 1):
                    q["id"] = f"q{n}"
            qs = kept
            if not qs:
                raise RuntimeError("Every question was missing information it needs; nothing left to ask.")
        if kind == "practice":
            sp = practice.spec_of(tid)
            qs = practice.drop_repeats(qs, sp, tid, lv.log)
            if len(qs) != sp.get("count"):   # the clock follows the questions that are left
                db.ex("UPDATE tests SET time_limit_min=? WHERE id=?", (practice.minutes({**sp, "count": len(qs)}), tid))
        if not qs:
            raise RuntimeError("The model returned no questions.")
        db.ex("UPDATE tests SET status='ready', source=?, questions=? WHERE id=?",
              (source, json.dumps(qs, ensure_ascii=False), tid))
        lv.d["phase"] = "ready"
        lv.log(f"Ready in {lv.elapsed():g} s", "done")
    except Exception as e:
        db.ex("UPDATE tests SET status='failed', error=? WHERE id=?", (str(e), tid))
        lv.d["phase"] = "failed"
        lv.log(str(e), "err")
    bus.publish("test", {"id": tid})


def public_view(tid: int) -> dict:
    t = db.decode(db.q1("SELECT * FROM tests WHERE id=?", (tid,)))
    if not t:
        raise state.Refused("Test yok.")
    if t["status"] != "submitted":
        for q in t["questions"]:
            for k in ("answer", "accept", "explanation"):
                q.pop(k, None)
    if t["status"] == "in_progress" or (t["status"] == "ready" and t.get("used_sec")):
        t["remaining_sec"] = max(0, t["time_limit_min"] * 60 - _used(t))
    t["threshold"] = _threshold_label(t)
    if t["status"] in ("generating", "ready", "failed") and (lv := _LIVE.get(tid)):
        t["live"] = lv
    if t["kind"] == "practice":
        sp = practice.spec_of(tid)
        t["practice"] = {k: sp.get(k) for k in ("topics", "count", "asked", "level", "level_why", "follow_of")}
        t["practice"]["from_task"] = bool(t.get("task_id"))
    return t


def _task_meta(task_id: int | None) -> dict:
    row = db.q1("SELECT meta FROM tasks WHERE id=?", (task_id,)) if task_id else None
    return json.loads(row["meta"]) if row and row["meta"] else {}


def _pass_mark(kind: str, n: int) -> float | None:
    """Right answers needed to pass a scored check, out of n questions; None for a test that only measures."""
    thr = profile.thresholds()
    if kind == "c_quiz":
        return thr["c_quiz"]["threshold"]
    if kind == "unit_quiz":
        u = thr.get("unit_quiz") or {"threshold": 4, "max": 5}
        return round(u["threshold"] * n / (u.get("max") or 5), 2)
    return None


def _threshold_label(t: dict) -> str:
    if t["kind"] == "c_quiz":
        return "Threshold 4/5 (closed-book C quiz)"
    if t["kind"] == "unit_quiz":
        u = profile.thresholds().get("unit_quiz") or {"threshold": 4, "max": 5}
        return (f"Pass mark {u['threshold']:g}/{u.get('max', 5):g} (closed-book unit check). Below it the unit is "
                "studied again and the check retaken.")
    if t["kind"] == "practice":
        sp = practice.spec_of(t["id"])
        head = ", ".join(x for x in (f"Practice on {sp['topics']}" if sp.get("topics") else "",
                                     f"follow-up to #{sp['follow_of']}" if sp.get("follow_of") else "") if x)
        if t.get("task_id"):
            return ((head + ". " if head else "") + "Practice: it doesn't count toward any pass mark (unit checks decide "
                    "those), but it shows in Progress → By topic, and wrong answers become sticking points that the "
                    "end-of-day test asks about again.")
        return ((head + ". " if head else "") + "Practice: it doesn't count toward any pass mark and makes no sticking "
                "points, but it shows in Progress → By topic.")
    return "The end-of-day test is a measurement, not a threshold: wrong answers become sticking points and go into tomorrow's plan."


def start(tid: int) -> None:
    t = db.q1("SELECT * FROM tests WHERE id=?", (tid,))
    if not t:
        raise state.Refused("No such test.")
    if t["kind"] != "practice":
        state.require_active(t["date"])
    if t["status"] == "ready":
        db.ex("UPDATE tests SET status='in_progress', started_at=? WHERE id=?", (db.ts(), tid))
        bus.publish("test", {"id": tid})


def save_answers(tid: int, answers: dict) -> None:
    t = db.q1("SELECT status FROM tests WHERE id=?", (tid,))
    if t and t["status"] == "in_progress":
        db.ex("UPDATE tests SET answers=? WHERE id=?", (json.dumps(answers, ensure_ascii=False), tid))


SHORT_GRADE = llm.strict({"type": "object", "properties": {"grades": {"type": "array", "items": {
    "type": "object", "properties": {"id": {"type": "string"}, "correct": {"type": "boolean"}, "note": {"type": "string"}}}}}})


def _used(t: dict) -> int:
    """Seconds of test time spent so far: earlier runs plus the one going on now."""
    run = (now() - datetime.fromisoformat(t["started_at"])).total_seconds() if t["started_at"] and t["status"] == "in_progress" else 0
    return int((t.get("used_sec") or 0) + max(0, run))


def leave(tid: int, answers: dict) -> dict:
    """Step out of a test without grading it: answers and the time used are kept, the clock stops,
    and Resume carries on from there. Nothing is scored and nothing becomes a sticking point."""
    t = db.q1("SELECT * FROM tests WHERE id=?", (tid,))
    if not t or t["status"] != "in_progress":
        raise state.Refused("Only a test in progress can be left.")
    db.ex("UPDATE tests SET status='ready', started_at=NULL, used_sec=?, answers=? WHERE id=?",
          (_used(t), json.dumps(answers, ensure_ascii=False), tid))
    bus.publish("test", {"id": tid, "status": "ready"})
    return public_view(tid)


def overdue(t: dict) -> bool:
    return t["status"] == "in_progress" and _used(t) > t["time_limit_min"] * 60 + GRACE_SEC


def active_exam() -> dict | None:
    """The test in progress that is still within its time (the coach is off while one runs)."""
    for t in db.q("SELECT * FROM tests WHERE status='in_progress' ORDER BY id DESC"):
        if not overdue(t):
            return t
    return None


async def expire_overdue() -> list[int]:
    """Submit tests whose time ran out (the tab was closed, the laptop slept) with the answers saved so far."""
    out = []
    for t in db.q("SELECT * FROM tests WHERE status='in_progress'"):
        if overdue(t):
            try:
                await submit(t["id"], json.loads(t["answers"] or "{}"), auto=True)
                out.append(t["id"])
            except Exception:  # noqa: BLE001
                log.exception("auto-submit of test %s failed", t["id"])
    return out


async def submit(tid: int, answers: dict, auto: bool = False) -> dict:
    t = db.decode(db.q1("SELECT * FROM tests WHERE id=?", (tid,)))
    if not t:
        raise state.Refused("No such test.")
    if t["status"] != "in_progress":
        raise state.Refused("Test not started or already submitted.")
    late = _used(t) > t["time_limit_min"] * 60 + 30
    results, pending = [], []
    for q in t["questions"]:
        given = str(answers.get(q["id"], ""))
        acc = [q["answer"], *q.get("accept", [])]
        ok = any(_norm(given) == _norm(a) for a in acc if a)
        r = {"id": q["id"], "given": given, "correct": ok, "answer": q["answer"], "explanation": q.get("explanation", ""),
             "topic": q.get("topic", "")}
        if not ok and q["type"] == "short" and given.strip() and has_api_key():
            pending.append((r, q))
        results.append(r)
    if pending:
        try:
            prompt = "\n\n".join(f"id={q['id']}\nQuestion: {q['prompt']}\nCorrect answer: {q['answer']}\nStudent's answer: {r['given']}"
                                 for r, q in pending)
            out = await llm.structured("Grade the short answers. Count an answer correct if it is equivalent in meaning and mathematically; "
                                       "incomplete or wrong means wrong. note: one sentence in English.", prompt, SHORT_GRADE, effort="low",
                                       max_tokens=4000)
            g = {x["id"]: x for x in out["grades"]}
            for r, q in pending:
                if g.get(q["id"], {}).get("correct"):
                    r["correct"], r["note"] = True, g[q["id"]].get("note", "")
        except Exception:
            log.exception("short grading failed")
    score = sum(r["correct"] for r in results)
    mx = len(results)
    db.ex("UPDATE tests SET status='submitted', answers=?, results=?, score=?, max=?, submitted_at=? WHERE id=?",
          (json.dumps(answers, ensure_ascii=False), json.dumps(results, ensure_ascii=False), score, mx, db.ts(), tid))
    if t["kind"] == "practice":
        if t["task_id"]:
            for r in results:
                if not r["correct"]:
                    r["stuck_id"] = state.add_stuck("wrong_answer", f"Practice set · {r['topic']}", t["task_id"],
                                                    f"Answer: {r['given'] or '(empty)'} · Correct: {r['answer']}", dedupe_min=0)
            db.ex("UPDATE tests SET results=? WHERE id=?", (json.dumps(results, ensure_ascii=False), tid))
            state.log_event("practice_submitted", t["task_id"], {"test_id": tid, "score": score, "max": mx})
        bus.publish("test", {"id": tid, "status": "submitted"})
        return public_view(tid)
    kind = t["kind"] if t["kind"] in ("c_quiz", "unit_quiz") else "eod_test"
    thr = _pass_mark(t["kind"], mx)
    passed = (score >= thr) if thr is not None else None
    label = {"eod_test": "End-of-day test", "c_quiz": "C quiz"}.get(kind) or _task_meta(t["task_id"]).get("item", "Unit check")
    db.ex("INSERT INTO scores(ts,date,task_id,kind,item,value,max,threshold,passed,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
          (db.ts(), t["date"], t["task_id"], kind, label,
           score, mx, thr, None if passed is None else int(passed),
           "auto-submitted when time ran out" if auto else "time exceeded" if late else None))
    for r in results:
        if not r["correct"]:
            r["stuck_id"] = state.add_stuck("wrong_answer", f"Wrong answer · {r['topic']}", t["task_id"],
                                            f"Answer: {r['given'] or '(empty)'} · Correct: {r['answer']}", dedupe_min=0)
    db.ex("UPDATE tests SET results=? WHERE id=?", (json.dumps(results, ensure_ascii=False), tid))
    state.log_event("test_submitted", t["task_id"], {"test_id": tid, "score": score, "max": mx, "late": late, "auto": auto},
                    d=datetime.fromisoformat(t["date"]).date())
    day = db.q1("SELECT status FROM days WHERE date=?", (t["date"],))
    if day and day["status"] == "closed":
        # submitted after the day was closed: bring its PROGRESS.md section up to date
        from .planner import write_progress
        try:
            write_progress(t["date"])
        except Exception:  # noqa: BLE001
            log.exception("PROGRESS.md update after a late test failed")
    bus.publish("test", {"id": tid, "status": "submitted"})
    return public_view(tid)


def void_question(tid: int, qid: int | str, why: str = "") -> dict:
    """The user says a question was broken (information missing, wrong answer key): it leaves the score, its
    sticking point is closed, and a scored check is passed or failed again on the questions that are left."""
    t = db.decode(db.q1("SELECT * FROM tests WHERE id=?", (tid,)))
    if not t or t["status"] != "submitted":
        raise state.Refused("Only a submitted test's questions can be marked broken.")
    results = t["results"] or []
    r = next((x for x in results if x["id"] == qid), None)
    if not r:
        raise state.Refused("No such question.")
    if r.get("void"):
        return public_view(tid)
    if sum(not x.get("void") for x in results) <= 1:
        raise state.Refused("That's the test's last question; retake the test instead.")
    r["void"], r["void_why"] = True, why.strip()[:300]
    if r.get("stuck_id"):
        state.resolve_stuck(r["stuck_id"])
    elif not r["correct"]:   # submitted before sticking points were linked to their question
        row = db.q1("SELECT id FROM stuck WHERE resolved=0 AND source='wrong_answer' AND detail=? AND ts>=? ORDER BY id LIMIT 1",
                    (f"Answer: {r['given'] or '(empty)'} · Correct: {r['answer']}", t["submitted_at"] or ""))
        if row:
            state.resolve_stuck(row["id"])
    live = [x for x in results if not x.get("void")]
    score, mx = sum(bool(x["correct"]) for x in live), len(live)
    db.ex("UPDATE tests SET results=?, score=?, max=? WHERE id=?", (json.dumps(results, ensure_ascii=False), score, mx, tid))
    if t["kind"] != "practice":
        thr = _pass_mark(t["kind"], mx)
        db.ex("UPDATE scores SET value=?, max=?, threshold=?, passed=? WHERE id=(SELECT id FROM scores WHERE task_id IS ? "
              "AND date=? AND kind=? ORDER BY id DESC LIMIT 1)",
              (score, mx, thr, None if thr is None else int(score >= thr), t["task_id"], t["date"],
               t["kind"] if t["kind"] in ("c_quiz", "unit_quiz") else "eod_test"))
    state.log_event("question_voided", t["task_id"], {"test_id": tid, "question": qid, "why": r["void_why"],
                                                       "score": score, "max": mx})
    bus.publish("test", {"id": tid, "status": "submitted"})
    return public_view(tid)

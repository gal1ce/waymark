"""Closing days, reshaping the next day from results, and creating new
reference days as the user advances (never more than HORIZON days ahead)."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import date, datetime, timedelta

from . import bus, db, files, health, llm, planlog, profile, prompts, state, tracks
from .config import (COACH_MD, HORIZON_STUDY_DAYS, KINTSUGI, STUDY_REPO, WEEKDAY_TR, WEEKDAY_TR_SHORT, has_api_key,
                     next_study_day, now, start_date, study_weekdays, today, week_index, week_start)
from .curriculum import (BEEJ_CHAPTERS, BEEJ_LAST, C_DS, C_DS_SESSIONS, KHAN_ALGEBRA_COUNT, KHAN_UNITS, KINTSUGI_ORDER,
                         PHASES, REWRITE_GROUPS, REWRITE_SESSIONS, RUNWAY_WARN_DAYS, USACO_BRONZE, beej_resource,
                         khan_item, khan_unit, khan_unit_resources, kintsugi_resources, runway, schedule)
from .seed import T, VIDEO_TIP, insert_tasks, monday

log = logging.getLogger("ctu.planner")

# One planner at a time: closing a day, filling the horizon and re-planning a future day all read and move
# the curriculum cursor. Public coroutines take the lock; the _underscore versions expect it to be held.
_lock = asyncio.Lock()

# ------------------------------------------------------------------ helpers
ENG_READING = {
    "c": [("Wikipedia · C (programming language) — Overview", "https://en.wikipedia.org/wiki/C_(programming_language)"),
          ("Wikipedia · Array (data structure)", "https://en.wikipedia.org/wiki/Array_(data_structure)"),
          ("Wikipedia · String (computer science)", "https://en.wikipedia.org/wiki/String_(computer_science)"),
          ("Wikipedia · Memory management", "https://en.wikipedia.org/wiki/Memory_management")],
    "kintsugi": [("Wikipedia · Page cache", "https://en.wikipedia.org/wiki/Page_cache"),
                 ("Wikipedia · Serialization", "https://en.wikipedia.org/wiki/Serialization"),
                 ("Wikipedia · Write-ahead logging", "https://en.wikipedia.org/wiki/Write-ahead_logging")],
}
ESSAY_PROMPTS = [
    "Some people think that students should learn programming at school from an early age. Others think it should be optional. Discuss both views and give your own opinion.",
    "Many young people now study abroad. What are the advantages and disadvantages of this?",
    "Some say technology makes people less creative. To what extent do you agree or disagree?",
    "Online learning is replacing traditional classrooms. Is this a positive or negative development?",
]


def _cursor() -> dict:
    return db.kv_get("cursor", {"khan_unit": 0, "beej_next": 6, "kintsugi_idx": 1, "quiz_from": 2,
                                "essay_n": 0, "eng_c": 0, "eng_k": 0})


# ------------------------------------------------------------------ next phases (need the user's approval)
def approved_phases() -> set[str]:
    return set(db.kv_get("approved_phases", []) or [])


def phases() -> list[dict]:
    """The CTU roadmap's next phases; a custom plan changes through Settings → Plan instead."""
    if not profile.is_ctu():
        return []
    ok = approved_phases()
    return [{"key": k, **v, "approved": k in ok} for k, v in PHASES.items()]


def set_phase(key: str, on: bool) -> list[dict]:
    if key not in PHASES:
        raise state.Refused("No such phase.")
    cur = approved_phases()
    if (key in cur) == on:
        return phases()
    cur = cur | {key} if on else cur - {key}
    db.kv_set("approved_phases", sorted(cur))
    state.log_event("phase_" + ("approved" if on else "withdrawn"), None, {"phase": key})
    # the approval is a plan decision: it goes into the coach log as well
    append_coach_log(f"Plan: '{PHASES[key]['label']}' {'onaylandı' if on else 'onayı geri alındı'} (uygulamadan).")
    check_runway()
    bus.publish("plan", {"phase": key})
    return phases()


def _khan_limit() -> int:
    return len(KHAN_UNITS) if "khan_geometry" in approved_phases() else KHAN_ALGEBRA_COUNT


def _last_khan(unit_idx: int) -> dict | None:
    return db.q1("SELECT value, passed FROM scores WHERE kind='khan_unit' AND item=? ORDER BY id DESC LIMIT 1",
                 (khan_item(unit_idx),))


def _math_tasks(unit: int) -> tuple[list, list]:
    limit = _khan_limit()
    unit = min(unit, limit - 1)
    name = khan_unit(unit)["name"]
    last = _last_khan(unit)
    if last and not last["passed"]:
        first = [T(f"{name} · study (last test {last['value']:g}%)", "khan_study", 120,
                   "The unit's lessons + exercises. Each exercise until mastered (5 of the last 7 right).\n\n" + VIDEO_TIP,
                   khan_unit_resources(unit), meta={"unit_idx": unit}),
                 T(f"{name} · unit test (retake)", "khan_test", 45, "≥ 90% → passed.", khan_unit_resources(unit),
                   meta={"unit_idx": unit, "score_kind": "khan_unit"})]
    else:
        first = [T(f"{name} · unit test", "khan_test", 45,
                   "Unit test first. ≥ 90% → skip the unit and move to the next one. Below that, go to the study task.",
                   khan_unit_resources(unit), meta={"unit_idx": unit, "score_kind": "khan_unit"}),
                 T(f"{name} · lessons + exercises", "khan_study", 135, "Only if the test is below 90%.\n\n" + VIDEO_TIP,
                   khan_unit_resources(unit), meta={"unit_idx": unit})]
    nxt = min(unit + 1, limit - 1)
    second = [T("Math II · continue", "khan_study", 120,
                f"If the morning unit passed, start with the **{khan_unit(nxt)['name']}** unit test. If not, keep studying, "
                "then retake the test.\n\n" + VIDEO_TIP,
                khan_unit_resources(nxt), meta={"unit_idx": nxt, "score_kind": "khan_unit"})]
    return first, second


def _eng_tasks(d: date, evening: str, cur: dict) -> list:
    ds = d.isoformat()
    if d.weekday() == 6:
        n = cur.get("essay_n", 0)
        prompt = ESSAY_PROMPTS[n % len(ESSAY_PROMPTS)]
        return [T(f"IELTS Task 2 essay #{n + 1}", "write", 60,
                  f"**40 minutes**, 250+ words, no dictionary or translation. Question:\n\n> {prompt}\n\nFile: `eng/essays/{ds}.md`. "
                  "The coach will give a band (target 6.0 by end of Phase 1).",
                  [{"label": "eng/essays/", "kind": "repo", "path": "eng/essays"}], files=[f"eng/essays/{ds}.md"],
                  meta={"essay_n": n + 1})]
    key = "eng_c" if evening == "c" else "eng_k"
    lst = ENG_READING[evening]
    title, url = lst[cur.get(key, 0) % len(lst)]
    slug = re.sub(r"[^a-z0-9]+", "-", title.split("·")[-1].lower()).strip("-")[:30]
    return [T(title, "read", 35, "Looking up single words is fine, no translating sentences.",
              [{"label": title, "kind": "url", "href": url}]),
            T(f"Summary · {title.split('·')[-1].strip()} (5 sentences)", "write", 25, f"File: `eng/{ds}-{slug}.md`.",
              [{"label": "eng/", "kind": "repo", "path": "eng"}], files=[f"eng/{ds}-{slug}.md"])]


def _c_tasks(d: date, cur: dict) -> list:
    ch = cur.get("beej_next", 6)
    tasks: list = []
    if d.weekday() == 6:
        qf = cur.get("quiz_from", 2)
        last = min(ch - 1, BEEJ_LAST)
        if last >= qf:
            tasks.append(T(f"Closed-book quiz · Beej {qf}–{last}", "c_quiz", 45,
                           "5 questions, 45 min, no book/AI/notes. Threshold 4/5. Start the test from here.", learning=0,
                           meta={"chapters": f"{qf}-{last}"}))
        chapters = [ch]
    else:
        chapters = [ch, ch + 1]
    for c in chapters:
        if c > BEEJ_LAST:
            break
        tasks.append(T(f"Beej {c} · {BEEJ_CHAPTERS[c - 1][1]}", "read", 45, "", [beej_resource(c)]))
        tasks.append(T(f"Beej {c} exercises", "exercise", 60,
                       "The agent will write the exercises (needs an API key). For now, type and compile every code "
                       "example in the chapter yourself, then change one thing and predict the result.",
                       [beej_resource(c), {"label": f"c/ch{c:02d}/", "kind": "repo", "path": f"c/ch{c:02d}"}],
                       meta={"chapter": c, "placeholder": True}))
    if not any(t["kind"] in ("read", "exercise") for t in tasks):
        if "c_ds" in approved_phases() and (d.weekday() == 6 or cur.get("ds_idx", 0) < len(C_DS_SESSIONS)):
            tasks += _c_ds_tasks(d, cur)
        else:
            tasks += _c_review(d, cur)
    return tasks


def _c_ds_tasks(d: date, cur: dict) -> list:
    """Approved next C phase: data structures on Mon/Wed, USACO Bronze on the Sunday C block."""
    if d.weekday() == 6:
        return [T("USACO Bronze · problems", "other", 180,
                  "Work through the next USACO Guide Bronze module in C++: read it, then solve its problems in "
                  "`usaco-guide/`. Log each problem (solved / stuck where) in `usaco-guide/log.md`.",
                  [{"label": "USACO Guide · Bronze", "kind": "url", "href": USACO_BRONZE},
                   {"label": "usaco-guide/", "kind": "repo", "path": "usaco-guide"}], learning=1)]
    i, step = C_DS_SESSIONS[cur.get("ds_idx", 0)]
    name, stem, url = C_DS[i]
    f = f"c/ds/{stem}.c"
    res = [{"label": f"Wikipedia · {name}", "kind": "url", "href": url}, beej_resource(12),
           {"label": "c/ds/", "kind": "repo", "path": "c/ds"}]
    if step == "build":
        return [T(f"{name} · read and design", "read", 40,
                  "Read the article. Write the struct and the function signatures on paper first: what each one "
                  "takes, returns and what it does on failure.", res[:2]),
                T(f"{name} · build it in {f}", "exercise", 200,
                  f"Implement the {name.lower()} in `{f}` with a `main` that tests every operation (including the empty "
                  "and full/edge cases) with `assert`. Then run it under AddressSanitizer "
                  "(`gcc -fsanitize=address -g`) and valgrind until both are clean.", res, files=[f],
                  meta={"ds_idx": cur.get("ds_idx", 0)})]
    g = f"c/ds/{stem}_rewrite.c"
    return [T(f"{name} · rewrite from an empty file (≤45 min)", "exercise", 90,
              f"Close `{f}`. In `{g}`, write the whole {name.lower()} again from nothing in 45 minutes or less, "
              "same tests. Threshold: it passes the tests and is ASan/valgrind clean.", res, files=[g],
              meta={"ds_idx": cur.get("ds_idx", 0)}),
            T(f"{name} · compare and fix", "review", 120,
              f"Diff `{g}` against `{f}`. For every difference: which is right, and why? Fix the weaker one; "
              "write the lessons as comments at the top of the rewrite.", res[2:])]


def _c_review(d: date, cur: dict) -> list:
    """Beej 1–12 (this phase) is done: review weak chapters instead of an empty evening. The next phase
    (COACH.md: USACO Bronze on Sundays, C data structures in Jan–Feb) needs the user's approval first."""
    n = cur.get("c_review", 0)
    weak = [int(x) for x in re.findall(r"Beej (\d+)", " ".join(
        s["summary"] for s in db.q("SELECT summary FROM stuck WHERE resolved=0 AND summary LIKE '%Beej%'")))]
    pool = sorted(set(weak)) or list(range(6, BEEJ_LAST + 1))
    c = pool[n % len(pool)]
    return [T(f"Review · Beej {c} · {BEEJ_CHAPTERS[c - 1][1]}", "review", 60,
              "Beej 1–12 is finished for this phase. Re-read the chapter's examples without the book first: write "
              "from memory what each one does, then check.", [beej_resource(c)], meta={"review_chapter": c}),
            T(f"Beej {c} · rewrite exercises from memory", "exercise", 120,
              "Pick two of your earlier exercises for this chapter and rewrite them from an empty file, no peeking. "
              "Then extend each with one new feature.",
              [beej_resource(c), {"label": f"c/ch{c:02d}/", "kind": "repo", "path": f"c/ch{c:02d}"}],
              meta={"chapter": c, "placeholder": True, "review": True}),
            T("Next C phase · ask the coach", "other", 15,
              "The C curriculum for this phase is used up. Ask the coach to propose the next phase "
              "(USACO Bronze, C data structures) and approve it before it goes into the plan.", learning=0)]


def _kintsugi_tasks(cur: dict) -> list:
    idx = cur.get("kintsugi_idx", 1)
    if idx > len(KINTSUGI_ORDER) - 1:
        if "kintsugi_rewrite" in approved_phases() and cur.get("rewrite_idx", 0) < len(REWRITE_SESSIONS):
            return _rewrite_tasks(cur)
        return _kintsugi_review(cur)
    files_ = KINTSUGI_ORDER[idx]
    stem = files_[-1].split("/")[-1].rsplit(".", 1)[0]
    tasks = [T(f"Read {f}", "kintsugi_read", 60 if f.endswith(".cpp") else 30,
               "For each function: what goes in, what it changes, who calls it, what happens on error?",
               kintsugi_resources([f])) for f in files_]
    used = sum(t["est_min"] for t in tasks)
    tasks.append(T(f"cpp/kintsugi/{stem}.md · explanation", "write", max(40, 200 - used),
                   "Without looking at the code, 1 paragraph: what this part does and who it serves. Then write and answer "
                   "5 questions that came up while reading. The coach will quiz you orally on these files (threshold 8/10).",
                   [{"label": "cpp/kintsugi/", "kind": "repo", "path": "cpp/kintsugi"}],
                   files=[f"cpp/kintsugi/{stem}.md"], meta={"kintsugi_idx": idx}))
    return tasks


def _rewrite_tasks(cur: dict) -> list:
    """Approved next Kintsugi phase: rewrite each part from your notes, then compare with the original."""
    n = cur.get("rewrite_idx", 0)
    g, step = REWRITE_SESSIONS[n]
    stem, what = REWRITE_GROUPS[g]
    originals = next((grp for grp in KINTSUGI_ORDER if any(stem.split("_")[0] in f for f in grp)), [])
    notes = {"label": f"cpp/kintsugi/{stem}.md (your notes)", "kind": "repo", "path": f"cpp/kintsugi/{stem}.md"}
    folder = {"label": "cpp/kintsugi/rewrite/", "kind": "repo", "path": "cpp/kintsugi/rewrite"}
    meta = {"rewrite_idx": n}
    if step == "header":
        f = f"cpp/kintsugi/rewrite/include/{stem}.h"
        return [T(f"Rewrite {what} · header from your notes", "rewrite", 200,
                  f"Without opening the original, write `{f}`: the class, its data members and every method with a "
                  "comment saying what it does and how it fails. Only your notes and the CMU lecture.",
                  [notes, folder, {"label": "CMU 15-445", "kind": "url", "href": "https://15445.courses.cs.cmu.edu/"}],
                  files=[f], meta=meta)]
    if step == "implement":
        f = f"cpp/kintsugi/rewrite/src/{stem}.cpp"
        return [T(f"Rewrite {what} · implementation", "rewrite", 220,
                  f"Implement `{f}` against your header, C++20, no AI and no peeking at the original.",
                  [notes, folder], files=[f], meta=meta)]
    f = f"cpp/kintsugi/rewrite/tests/{stem}_test.cpp"
    return [T(f"Rewrite {what} · tests", "rewrite", 140,
              f"Write `{f}`: the cases that matter (empty, full, error paths, reopen after close). Make them pass.",
              [folder], files=[f], meta=meta),
            T(f"Compare {what} with the original", "kintsugi_read", 80,
              "Now open the original. List every difference in your notes: bug in yours, bug in theirs, or a "
              "different choice, and why.", kintsugi_resources(originals) if originals else [folder])]


def _kintsugi_review(cur: dict) -> list:
    """Every file group has been read. Until the rewrite phase is approved, evenings go to oral prep."""
    n = cur.get("kintsugi_review", 0)
    group = KINTSUGI_ORDER[n % len(KINTSUGI_ORDER)]
    stem = group[-1].split("/")[-1].rsplit(".", 1)[0]
    return [T(f"Review · {stem} without the code", "review", 90,
              "Explain the part from your notes only: data layout, who calls what, error paths. Then open the code "
              "and mark what you got wrong.", kintsugi_resources(group), meta={"kintsugi_review": n % len(KINTSUGI_ORDER)}),
            T(f"Oral prep · {stem}", "review", 120,
              "Ask the coach for the oral quiz on these files (threshold 8/10).",
              [{"label": "cpp/kintsugi/", "kind": "repo", "path": "cpp/kintsugi"}]),
            T("Next Kintsugi phase · ask the coach", "other", 15,
              "The reading order is finished. Ask the coach to propose the rewrite phase (page I/O + buffer pool) "
              "and approve it before it goes into the plan.", learning=0)]


def _test_tasks() -> list:
    return monday()["test"]


def template_day(d: date, cur: dict) -> dict:
    evening = schedule(d.weekday())[5]["kind"]
    m1, m2 = _math_tasks(cur.get("khan_unit", 0))
    plan = {"math": m1, "math2": m2, "eng": _eng_tasks(d, evening, cur), "test": _test_tasks()}
    plan[evening] = _c_tasks(d, cur) if evening == "c" else _kintsugi_tasks(cur)
    return plan


def _advance_cursor(d: date, plan: dict) -> None:
    cur = _cursor()
    evening = schedule(d.weekday())[5]["kind"]
    if evening == "c":
        chs = []
        for t in plan.get("c", []):
            m = re.match(r"Beej (\d+)", t["title"])
            ch = t["meta"].get("chapter") or (int(m.group(1)) if m and t["kind"] == "read" else 0)
            if ch:
                chs.append(ch)
        if chs:
            cur["beej_next"] = max(chs) + 1
        if any(t["kind"] == "c_quiz" for t in plan.get("c", [])):
            cur["quiz_from"] = cur.get("beej_next", 6) - (1 if d.weekday() == 6 else 0)
        if any(t["meta"].get("review_chapter") for t in plan.get("c", [])):
            cur["c_review"] = cur.get("c_review", 0) + 1
        if any("ds_idx" in t["meta"] for t in plan.get("c", [])):
            cur["ds_idx"] = cur.get("ds_idx", 0) + 1
        cur["eng_c"] = cur.get("eng_c", 0) + (d.weekday() != 6)
    else:
        if any("rewrite_idx" in t["meta"] for t in plan.get("kintsugi", [])):
            cur["rewrite_idx"] = cur.get("rewrite_idx", 0) + 1
        elif any("kintsugi_review" in t["meta"] for t in plan.get("kintsugi", [])):
            cur["kintsugi_review"] = cur.get("kintsugi_review", 0) + 1
        elif cur.get("kintsugi_idx", 1) <= len(KINTSUGI_ORDER) - 1:
            cur["kintsugi_idx"] = cur.get("kintsugi_idx", 1) + 1
        cur["eng_k"] = cur.get("eng_k", 0) + 1
    if d.weekday() == 6:
        cur["essay_n"] = cur.get("essay_n", 0) + 1
    db.kv_set("cursor", cur)


# ------------------------------------------------------------------ LLM shaping
RES = {"type": "object", "properties": {"label": {"type": "string"},
                                        "kind": {"type": "string", "enum": ["url", "repo", "kintsugi"]},
                                        "target": {"type": "string"}}}
TASK = {"type": "object", "properties": {
    "title": {"type": "string"},
    "kind": {"type": "string", "enum": ["read", "exercise", "khan_test", "khan_study", "write", "kintsugi_read",
                                        "c_quiz", "review", "rewrite", "other"]},
    "est_min": {"type": "integer"}, "detail": {"type": "string"},
    "resources": {"type": "array", "items": RES}, "files": {"type": "array", "items": {"type": "string"}},
    "learning": {"type": "boolean"}, "unit_idx": {"type": "integer"}, "chapter": {"type": "integer"}}}
PLAN_SCHEMA = llm.strict({"type": "object", "properties": {
    "adapt_note": {"type": "string"},
    "math": {"type": "array", "items": TASK}, "math2": {"type": "array", "items": TASK},
    "eng": {"type": "array", "items": TASK}, "evening": {"type": "array", "items": TASK}}})

def _to_internal(t: dict) -> dict:
    res = []
    for r in t.get("resources", []):
        if r["kind"] == "url":
            res.append({"label": r["label"], "kind": "url", "href": r["target"]})
        else:
            res.append({"label": r["label"], "kind": r["kind"], "path": r["target"]})
    meta = {}
    if t.get("unit_idx", -1) >= 0:
        meta["unit_idx"] = t["unit_idx"]
        if t["kind"] == "khan_test" or "unit test" in t["title"].lower():
            meta["score_kind"] = "khan_unit"
    if t.get("chapter"):
        meta["chapter"] = t["chapter"]
    if t["kind"] == "c_quiz":
        m = re.search(r"(\d+)\s*[–-]\s*(\d+)", t["title"])
        if m:
            meta["chapters"] = f"{m.group(1)}-{m.group(2)}"
    return T(t["title"], t["kind"], max(5, int(t["est_min"])), t["detail"], res, t.get("files", []),
             int(t.get("learning", True)), meta)


_EXERCISE_FILE = re.compile(r"c/(?:ch\d\d|ds)/[A-Za-z0-9_\-]+\.c")
_REWRITE_FILE = re.compile(r"cpp/kintsugi/rewrite/(?:include|src|tests)/[A-Za-z0-9_\-]+\.(?:h|hpp|cpp)")
_WRITE_FILE = re.compile(r"(?:eng|cpp/kintsugi)/(?:[A-Za-z0-9_\-]+/)*[A-Za-z0-9_\-][A-Za-z0-9_.\-]*\.md")
_REPO_PATH = re.compile(r"(?:[A-Za-z0-9_\-][A-Za-z0-9_.\-]*/)*[A-Za-z0-9_\-][A-Za-z0-9_.\-]*/?")


def _safe_rel(path: str, pattern: re.Pattern) -> bool:
    return bool(pattern.fullmatch(path or "")) and ".." not in path.split("/")


def _clean_resources(t: dict) -> list[dict]:
    out = []
    for r in t["resources"]:
        if r["kind"] == "url":
            if re.match(r"https://[^\s/]+", r.get("href") or ""):
                out.append(r)
        elif r["kind"] == "repo":
            if _safe_rel(r.get("path", ""), _REPO_PATH):
                out.append(r)
        elif r["kind"] == "kintsugi":
            p = (KINTSUGI / r.get("path", "")).resolve()
            if KINTSUGI.resolve() in p.parents and p.is_file():
                out.append(r)
    return out


def _task_ok(t: dict) -> bool:
    if t["kind"] == "exercise":
        return bool(t["files"]) and all(_safe_rel(f, _EXERCISE_FILE) for f in t["files"])
    if t["kind"] == "write":
        return bool(t["files"]) and all(_safe_rel(f, _WRITE_FILE) for f in t["files"])
    if t["kind"] == "rewrite":
        return bool(t["files"]) and all(_safe_rel(f, _REWRITE_FILE) for f in t["files"])
    return not t["files"]   # only exercises, writing and rewrite tasks name files


def _valid(plan: dict) -> dict:
    """Keep what fits the block and stays inside the allowed folders; drop the rest, one task at a time."""
    for key, limit in profile.block_min().items():
        tasks = []
        total = 0
        for t in plan.get(key, []):
            if not _task_ok(t):
                log.info("planner: dropped %r (files %s)", t["title"], t["files"])
                continue
            if total + t["est_min"] > limit + 15:
                log.info("planner: dropped %r (over the %d min block)", t["title"], limit)
                continue
            t["resources"] = _clean_resources(t)
            tasks.append(t)
            total += t["est_min"]
        plan[key] = tasks
    return plan


async def _llm_plan(d: date, draft: dict, context: str) -> tuple[dict, str] | None:
    if not has_api_key():
        return None
    evening = schedule(d.weekday())[5]["kind"]
    draft_view = {k: [{"title": t["title"], "kind": t["kind"], "est_min": t["est_min"], "detail": t["detail"][:300],
                       "files": t["files"], "meta": t["meta"]} for t in v] for k, v in draft.items() if k != "test"}
    prompt = (f"Day: {d.isoformat()} {WEEKDAY_TR[d.weekday()]} (week {profile.week_no(week_index(d))}). Evening block: {evening}.\n\n"
              f"Draft (built by the planner rules; improve it and fill the gaps):\n"
              f"{json.dumps(draft_view, ensure_ascii=False, indent=1)}\n\nContext:\n{context}")
    try:
        out = await llm.structured(prompts.planner_system(), prompt, PLAN_SCHEMA, effort="high", max_tokens=32000)
    except Exception:
        log.exception("planner LLM failed for %s", d)
        return None
    plan = {k: [_to_internal(t) for t in out[k]] for k in ("math", "math2", "eng")}
    plan[evening] = [_to_internal(t) for t in out["evening"]]
    plan = _valid({**plan, "evening": plan[evening]})
    plan[evening] = plan.pop("evening")
    # a block the model left empty (or whose tasks were all dropped) keeps the draft: a block is never planned bare
    for key, tasks in draft.items():
        if key != "test" and tasks and not plan.get(key):
            log.info("planner: %s came back empty for %s; keeping the draft", key, d)
            plan[key] = tasks
    plan["test"] = _test_tasks()
    return plan, out["adapt_note"]


def _context(ds_until: str) -> str:
    from .agent import _history
    hist = _history(7)
    stuck = db.q("SELECT summary, source, date FROM stuck WHERE resolved=0 ORDER BY id DESC LIMIT 30")
    cur = _cursor()
    coach = COACH_MD.read_text()[:6000] if COACH_MD.exists() else ""
    return (f"Cursor: {json.dumps(cur)} (khan_unit = index of the next Khan unit, beej_next = next Beej chapter)\n"
            f"Khan units in order: {[khan_item(i) for i in range(len(KHAN_UNITS))]}\n"
            f"Recent days: {json.dumps(hist, ensure_ascii=False, default=str)[:12000]}\n"
            f"Open sticking points: {json.dumps(stuck, ensure_ascii=False)}\n\nCOACH.md:\n{coach}")


# ------------------------------------------------------------------ public API
async def _generate_reference(d: date) -> None:
    if not profile.is_ctu():
        return await _generate_track_day(d)
    cur = _cursor()
    plan = template_day(d, cur)
    note = "Planned ahead from the template; it may still change after your results."
    shaped = await _llm_plan(d, plan, _context(d.isoformat()))
    if shaped:
        plan, note = shaped
        note = "Planned ahead: " + note
    ds = d.isoformat()
    # the day, its tasks and the cursor move land together: a crash can't leave an empty day behind
    with db.tx():
        db.ex("INSERT OR REPLACE INTO days(date,week,kind,version,status,title,adapt_note,created_at) VALUES(?,?,?,?,?,?,?,?)",
              (ds, week_index(d), "study", "reference", "planned", WEEKDAY_TR[d.weekday()], note, db.ts()))
        insert_tasks(d, plan)
        _advance_cursor(d, plan)
    bus.publish("plan", {"date": ds})


async def _generate_track_day(d: date) -> None:
    """A day of a custom plan: the tracks planner's draft, shaped by the model when there is a key."""
    plan = tracks.template_day(d)
    note = "Planned ahead from your plan; it may still change after your results."
    shaped = await tracks.llm_plan(d, plan, tracks.context())
    if shaped:
        plan, note = shaped
        note = "Planned ahead: " + note
    ds = d.isoformat()
    with db.tx():
        db.ex("INSERT OR REPLACE INTO days(date,week,kind,version,status,title,adapt_note,created_at) VALUES(?,?,?,?,?,?,?,?)",
              (ds, week_index(d), "study", "reference", "planned", WEEKDAY_TR[d.weekday()], note, db.ts()))
        insert_tasks(d, plan)
        tracks.advance(d, plan)
    bus.publish("plan", {"date": ds})


def _block_len(block_id: int) -> int:
    b = db.q1("SELECT start, end FROM blocks WHERE id=?", (block_id,))
    return tracks._minutes(b) if b else 240


def _next_block(kind: str, after: str) -> dict | None:
    return db.q1("SELECT b.id, b.date FROM blocks b JOIN days d ON d.date=b.date "
                 "WHERE b.kind=? AND b.date>? AND d.status='planned' ORDER BY b.date LIMIT 1", (kind, after))


def _move(task: dict, block: dict, ord_: int, carried_from: str | None) -> None:
    meta = json.loads(task["meta"]) if isinstance(task["meta"], str) else task["meta"]
    detail = task["detail"]
    if carried_from:
        meta["carried_from"] = carried_from
        meta.setdefault("orig_id", task["id"])
        if not detail.startswith("**"):
            detail = f"**Carried over from {carried_from}.**\n\n" + detail
    db.ex("INSERT INTO tasks(date,block_id,ord,title,detail,kind,learning,resources,files,est_min,meta) "
          "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          (block["date"], block["id"], ord_, task["title"], detail, task["kind"], task["learning"],
           task["resources"] if isinstance(task["resources"], str) else json.dumps(task["resources"], ensure_ascii=False),
           task["files"] if isinstance(task["files"], str) else json.dumps(task["files"], ensure_ascii=False),
           task["est_min"], json.dumps(meta, ensure_ascii=False)))


def _rebalance(kind: str, after: str) -> None:
    """Push overflow (last tasks first) forward block by block so no block exceeds its length."""
    for _ in range(30):
        blk = _next_block(kind, after)
        if not blk:
            return
        cap = profile.block_cap().get(kind) or _block_len(blk["id"])
        tasks = db.q("SELECT * FROM tasks WHERE block_id=? ORDER BY ord", (blk["id"],))
        total, keep, spill = 0, [], []
        for t in tasks:
            if total + t["est_min"] <= cap + 15 or not keep:
                keep.append(t)
                total += t["est_min"]
            else:
                spill.append(t)
        if spill:
            # English readings are interchangeable: overflow is dropped, not pushed down the week.
            nxt = _next_block(kind, blk["date"]) if kind != "eng" else None
            for t in spill:
                db.ex("DELETE FROM tasks WHERE id=?", (t["id"],))
            if nxt:
                db.ex("UPDATE tasks SET ord=ord+? WHERE block_id=?", (len(spill), nxt["id"]))
                for i, t in enumerate(spill):
                    _move(t, nxt, i, None)
            elif kind != "eng":
                (_rewind_cursor if profile.is_ctu() else tracks.rewind)(spill)
        after = blk["date"]


def _rewind_cursor(dropped: list[dict]) -> None:
    """Work pushed past the last generated day goes back to the cursor so it is planned again later."""
    cur = _cursor()
    chs = [json.loads(t["meta"]).get("chapter") for t in dropped]
    chs += [int(m.group(1)) for t in dropped if (m := re.match(r"Beej (\d+)", t["title"]))]
    chs = [c for c in chs if c]
    if chs:
        cur["beej_next"] = min(cur.get("beej_next", 99), min(chs))
    ks = [json.loads(t["meta"]).get("kintsugi_idx") for t in dropped]
    ks = [k for k in ks if k is not None]
    if ks:
        cur["kintsugi_idx"] = min(cur.get("kintsugi_idx", 99), min(ks))
    db.kv_set("cursor", cur)


def _carry_over(closed: str) -> None:
    """Unfinished work moves (in order) to the next day with the same kind of block: the CTU plan's evening and English
    blocks (math follows the unit tests instead), every track of a custom plan."""
    kinds = ["c", "kintsugi", "eng"] if profile.is_ctu() else tracks.carry_kinds()
    if not kinds:
        return
    rows = db.q("SELECT t.*, b.kind AS bkind FROM tasks t JOIN blocks b ON b.id=t.block_id "
                f"WHERE t.date=? AND t.status<>'done' AND b.kind IN ({','.join('?' * len(kinds))}) "
                "AND t.kind NOT IN ('test','c_quiz') AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.task_id=t.id) "
                "ORDER BY b.ord, t.ord", (closed, *kinds))   # a check that was taken is not carried: its score stands
    by_kind: dict[str, list] = {}
    for r in rows:
        m = json.loads(r["meta"] or "{}")
        if m.get("track") and tracks.is_removed(profile.track(m["track"]), m.get("unit")):
            continue   # its unit was taken out of the plan: nothing to carry
        by_kind.setdefault(r["bkind"], []).append(r)
    for kind, items in by_kind.items():
        target = _next_block(kind, closed)
        if not target:
            continue
        already = {json.loads(t["meta"]).get("orig_id") for t in db.q("SELECT meta FROM tasks WHERE date=?", (target["date"],))}
        items = [r for r in items if (json.loads(r["meta"]).get("orig_id") or r["id"]) not in already]
        db.ex("UPDATE tasks SET ord=ord+? WHERE block_id=?", (len(items), target["id"]))
        for i, r in enumerate(items):
            _move(r, target, i, closed)
        _rebalance(kind, closed)


def _plan_from_db(ds: str) -> dict:
    plan: dict = {}
    seen: dict[str, int] = {}
    for b in db.q("SELECT * FROM blocks WHERE date=? ORDER BY ord", (ds,)):
        n = seen[b["kind"]] = seen.get(b["kind"], 0) + 1
        key = b["kind"] if n == 1 else f"{b['kind']}{n}"
        if b["kind"] == "break":
            continue
        plan[key] = [T(t["title"], t["kind"], t["est_min"], t["detail"], json.loads(t["resources"]),
                       json.loads(t["files"]), t["learning"], json.loads(t["meta"]))
                     for t in db.q("SELECT * FROM tasks WHERE block_id=? ORDER BY ord", (b["id"],))]
    return plan


def touched(ds: str) -> bool:
    """True once the user has worked on the day: a task started, done or timed, a score, or a test.
    Such a day is never rebuilt, only added to."""
    return bool(db.q1("SELECT 1 FROM tasks WHERE date=? AND (first_started_at IS NOT NULL OR status<>'todo' "
                      "OR spent_sec>0) LIMIT 1", (ds,))
                or db.q1("SELECT 1 FROM scores WHERE date=? LIMIT 1", (ds,))
                or db.q1("SELECT 1 FROM tests WHERE date=? AND kind<>'practice' LIMIT 1", (ds,)))


async def _adapt_day(ds: str, extra_instructions: str = "") -> bool:
    """Rebuild a planned day from the latest results. Returns False (and changes nothing) when the user
    already worked on it, so started tasks, their time and their scores are never wiped."""
    if touched(ds):
        log.info("adapt %s skipped: the day already has work on it", ds)
        return False
    d = date.fromisoformat(ds)
    plan = _plan_from_db(ds)
    if not profile.is_ctu():
        return await _reshape_track_day(d, plan, extra_instructions)
    m1, m2 = _math_tasks(_cursor().get("khan_unit", 0))
    plan["math"], plan["math2"] = m1, m2           # math always follows the latest unit-test result
    note = "Adapted: math follows the latest unit test result, leftover work carried over."
    ctx = _context(ds) + (f"\n\nExtra instruction from the conversation with the user: {extra_instructions}" if extra_instructions else "")
    shaped = await _llm_plan(d, plan, ctx)
    if shaped:
        plan, note = shaped
    with db.tx():
        # checked again: the user may have started a task while the model was writing
        if touched(ds):
            log.info("adapt %s dropped: work started while it was being planned", ds)
            return False
        db.ex("UPDATE days SET version='adapted', adapt_note=? WHERE date=?", (note, ds))
        insert_tasks(d, plan)
    bus.publish("plan", {"date": ds})
    return True


async def _reshape_track_day(d: date, plan: dict, extra: str) -> bool:
    """A future day of a custom plan, planned again by the model (the coach's update_future_day)."""
    ds = d.isoformat()
    ctx = tracks.context() + (f"\n\nExtra instruction from the conversation with the user: {extra}" if extra else "")
    shaped = await tracks.llm_plan(d, plan, ctx)
    if not shaped:
        return False
    plan, note = shaped
    with db.tx():
        if touched(ds):
            return False
        db.ex("UPDATE days SET version='adapted', adapt_note=? WHERE date=?", (note, ds))
        insert_tasks(d, plan)
    bus.publish("plan", {"date": ds})
    return True


def _retakes_after(closed: str) -> list[str]:
    """A custom plan after a close: each unit check below the pass mark gets a review and a retake at the start of the
    next untouched block of its track (later work moves down; overflow is pushed forward)."""
    changed = []
    for tr in profile.tracks():
        idx = tracks._failed_unit(tr, len(tr.get("units") or []))
        if idx is None:
            continue
        for blk in db.q("SELECT b.id, b.date, b.start, b.end FROM blocks b JOIN days d ON d.date=b.date "
                        "WHERE b.kind=? AND b.date>? AND d.status='planned' ORDER BY b.date, b.ord", (tr["key"], closed)):
            if touched(blk["date"]):
                continue
            new = tracks.retake_tasks(tr, idx, tracks._minutes(blk))
            with db.tx():
                db.ex("UPDATE tasks SET ord=ord+? WHERE block_id=?", (len(new), blk["id"]))
                for i, t in enumerate(new):
                    _move({**t, "id": None, "learning": int(t["learning"])}, blk, i, None)
                db.ex("UPDATE days SET version='adapted', adapt_note=? WHERE date=?",
                      (f"Adapted: {tracks.item(tr, idx)} is studied again and its unit check retaken first.", blk["date"]))
                _rebalance(tr["key"], (date.fromisoformat(blk["date"]) - timedelta(days=1)).isoformat())
            changed.append(blk["date"])
            bus.publish("plan", {"date": blk["date"]})
            break
    return changed


async def adapt_day(ds: str, extra_instructions: str = "") -> bool:
    async with _lock:
        return await _adapt_day(ds, extra_instructions)


def ensure_anchor() -> date:
    t = today()
    anchor = max(t, start_date())
    last_closed = db.q1("SELECT MAX(date) d FROM days WHERE status='closed'")["d"]
    if last_closed:
        anchor = max(anchor, next_study_day(date.fromisoformat(last_closed)))
    return anchor


async def _ensure_horizon() -> None:
    if not profile.ready():
        return   # a new install plans nothing until its plan is approved
    t = today()
    if not profile.is_ctu() and t >= start_date() and profile.is_study_day(t) and \
            not db.q1("SELECT 1 FROM days WHERE date=?", (t.isoformat(),)):
        await _generate_reference(t)   # a plan approved on a study day starts today (the CTU plan seeds its first days)
    d = ensure_anchor()
    # The loop below starts after the anchor, taking it as planned already. A study day ahead can be the anchor
    # without being planned: the plan's first day when it starts later, or an added study day. It is planned first;
    # days after it planned before it (an older version skipped it) are planned again, so the work stays in order.
    if not profile.is_ctu() and d > t and profile.is_study_day(d) and not db.q1("SELECT 1 FROM days WHERE date=?", (d.isoformat(),)):
        if db.q1("SELECT 1 FROM days WHERE status='planned' AND date>?", (d.isoformat(),)):
            _drop_ahead(d)
        await _generate_reference(d)
    for _ in range(HORIZON_STUDY_DAYS):
        d = next_study_day(d)
        ds = d.isoformat()
        row = db.q1("SELECT status FROM days WHERE date=?", (ds,))
        empty = row and row["status"] == "planned" and not db.q1("SELECT 1 FROM tasks WHERE date=? LIMIT 1", (ds,))
        if not row or empty:
            await _generate_reference(d)
    check_runway()


async def ensure_horizon() -> None:
    async with _lock:
        await _ensure_horizon()


def _drop_ahead(since: date) -> list[str]:
    """Planned days from `since` on that nobody has worked on are taken out, and their work goes back to the tracks'
    cursor, so the next planning fills them again in order from the plan as it is now. A day with work on it stays,
    and so does every day before it."""
    rows = db.q("SELECT date FROM days WHERE status='planned' AND date>=? ORDER BY date", (max(since, today()).isoformat(),))
    worked = [r["date"] for r in rows if touched(r["date"])]
    drop = [r["date"] for r in rows if not worked or r["date"] > worked[-1]]
    if not drop:
        return []
    marks = ",".join("?" * len(drop))
    with db.tx():
        work = db.q(f"SELECT * FROM tasks WHERE date IN ({marks}) ORDER BY date, block_id, ord", tuple(drop))
        for table in ("tasks", "blocks", "days"):
            db.ex(f"DELETE FROM {table} WHERE date IN ({marks})", tuple(drop))
        tracks.rewind(work)
    return drop


async def set_unit(track: str, idx: int, on: bool) -> dict:
    """A unit taken out of the approved plan (on=False) or put back. The days ahead nobody has started are planned
    again, so the remaining units move up (or the unit put back comes next); started days keep their tasks."""
    from . import onboarding
    async with _lock:
        changed = onboarding.set_plan_unit(track, idx, on)
        dropped = []
        if changed:
            dropped = _drop_ahead(today())
            if on:
                tracks.put_back(profile.track(track), idx)
            await _ensure_horizon()
    for ds in dropped:
        bus.publish("plan", {"date": ds})
    return {"changed": changed, "replanned": dropped}


async def start_now() -> dict:
    """A plan of the user's own that starts on a later day starts today instead: its start moves to today and the days
    planned ahead are planned again from it, so the first work comes today and every day after moves up. A today the
    plan has off becomes a one-off study day."""
    from . import onboarding
    if profile.key() != "custom":
        raise state.Refused("Starting early is for a plan of your own.")
    t = today()
    if t >= start_date():
        raise state.Refused("The plan has started already.")
    async with _lock:
        onboarding.set_start(t)
        dropped = _drop_ahead(t)
        if t.weekday() not in study_weekdays():
            db.kv_set("extra_days", {**profile.extra_days(), t.isoformat(): sorted(study_weekdays())[0]})
        await _ensure_horizon()
    for ds in [t.isoformat(), *dropped]:
        bus.publish("plan", {"date": ds})
    return {"start_date": t.isoformat(), "replanned": dropped}


# ------------------------------------------------------------------ one-off study days
EXTRA_AHEAD_DAYS = 120   # how far ahead a study day can be added on a day off


async def add_extra_day(ds: str, like: int | None = None) -> dict:
    """A study day on a day the plan has off, for that date only: it uses the blocks of one of the plan's study
    weekdays and works on what comes next in each track, so the planned days after it are planned again (their work
    moves up). The weekly pattern doesn't change."""
    if profile.key() != "custom":
        raise state.Refused("Studying on a day off is for a plan of your own.")
    d = date.fromisoformat(ds)
    if d < today():
        raise state.Refused("That day is over.")
    if d < start_date():
        raise state.Refused("That day is before the plan starts.")
    if d > today() + timedelta(days=EXTRA_AHEAD_DAYS):
        raise state.Refused("That day is too far ahead; add it closer to the date.")
    if profile.is_study_day(d):
        raise state.Refused("That is a study day already.")
    days = sorted(study_weekdays())
    if like is None:
        like = days[0]
    if like not in days:
        raise state.Refused("Pick one of the plan's study days to copy.")
    async with _lock:
        db.kv_set("extra_days", {**profile.extra_days(), ds: like})
        dropped = _drop_ahead(d)
        await _ensure_horizon()
    for x in [ds, *dropped]:
        bus.publish("plan", {"date": x})
    return {"date": ds, "like": like, "replanned": dropped}


async def remove_extra_day(ds: str) -> dict:
    """Takes back a study day added on a day off, while nobody has worked on it; its work goes back to the days after."""
    d = date.fromisoformat(ds)
    if ds not in profile.extra_days():
        raise state.Refused("That isn't a study day you added.")
    if d < today():
        raise state.Refused("That day is over; it stays as it was.")
    if touched(ds):
        raise state.Refused("You already worked on that day; it stays.")
    async with _lock:
        dropped = _drop_ahead(d)
        extra = profile.extra_days()
        extra.pop(ds, None)
        db.kv_set("extra_days", extra)
        with db.tx():   # in case a later day with work kept it out of the drop
            db.ex("DELETE FROM tasks WHERE date=?", (ds,))
            db.ex("DELETE FROM blocks WHERE date=?", (ds,))
            db.ex("DELETE FROM days WHERE date=?", (ds,))
        await _ensure_horizon()
    for x in [ds, *dropped]:
        bus.publish("plan", {"date": x})
    return {"date": ds, "replanned": dropped}


def check_runway() -> dict:
    if not profile.is_ctu():
        return {"tracks": tracks.check_runway()}
    ok = approved_phases()
    r = runway(_cursor(), max(today(), start_date()) - timedelta(days=1), next_study_day, approved=ok)
    for key, label, phase in (("c_days", "C", "c_ds"), ("kintsugi_days", "Kintsugi", "kintsugi_rewrite")):
        left = r[key]
        if left is not None and left < RUNWAY_WARN_DAYS:
            if phase in ok:
                msg = (f"{label}: new material for {left} more study day(s), including the approved "
                       f"'{PHASES[phase]['label']}'. The roadmap's next step has to be added to the curriculum.")
            else:
                msg = (f"{label}: new material for {left} more study day(s). After that the evenings review earlier "
                       f"work until you approve the next phase, '{PHASES[phase]['label']}' (Profile → Health).")
            health.warn(f"runway_{key}", msg)
        else:
            health.clear(f"runway_{key}")
    if r["khan_units_left"] <= 2:
        health.warn("runway_khan", f"Khan: {r['khan_units_left']} unit(s) left. " + (
            "Geometry is approved; Precalculus comes next in the roadmap and has to be added." if "khan_geometry" in ok
            else "Approve the next phase, 'Khan Geometry' (Profile → Health), or the mornings repeat the last unit."))
    else:
        health.clear("runway_khan")
    return r


def _fmt_min(sec: int) -> str:
    return f"{sec // 3600} s {sec % 3600 // 60} dk"


def _progress_entry(ds: str) -> list[str]:
    day = state.get_day(ds, reveal=True)
    lines = [f"- Saat: {_fmt_min(day['progress']['spent_sec'])}"]
    for b in day.get("blocks", []):
        if b["kind"] in ("break", "test"):
            continue
        done = [t["title"] for t in b["tasks"] if t["status"] == "done"]
        left = [t["title"] for t in b["tasks"] if t["status"] != "done"]
        lines.append(f"- {b['title']}: " + (("bitti: " + ", ".join(done)) if done else "biten yok") +
                     (("; kalan: " + ", ".join(left)) if left else ""))
    for s in db.q("SELECT item,value,max,threshold,passed,note FROM scores WHERE date=? ORDER BY id", (ds,)):
        res = "" if s["passed"] is None else (" → geçti" if s["passed"] else " → eşik altı")
        lines.append(f"- Puan: {s['item']} {s['value']:g}/{s['max']:g}{res}" + (f" ({s['note']})" if s["note"] else ""))
    try:
        from . import khan
        k = khan.summary(ds)
        if k["questions"] or k["mastered"]:
            lines.append(f"- Khan alıştırma: {k['questions']} soru, {k['right']} ilk denemede doğru" +
                         (f"; ustalaşılan: {', '.join(k['mastered'])}" if k["mastered"] else ""))
    except Exception:  # noqa: BLE001 - a missing channel must not block the day's entry
        log.exception("khan summary failed")
    stuck = [s["summary"] for s in day.get("stuck", [])]
    lines.append("- Takıldığım yer: " + ("; ".join(stuck[:12]) if stuck else "yok"))
    if day.get("summary"):
        lines.append("- Notlar:\n" + "\n".join("  " + x for x in day["summary"].splitlines()))
    return lines


def progress_text(text: str | None, ds: str, entry: list[str]) -> str:
    """PROGRESS.md with the app's section for `ds` written or replaced. The app's part sits between
    <!-- ctu:DATE --> markers and only that part is ever replaced; everything else stays byte for byte.
    Plain string slicing: notes with LaTeX or backslashes are written exactly as they are."""
    d = date.fromisoformat(ds)
    header = f"## {ds} {WEEKDAY_TR_SHORT[d.weekday()]}"
    text = text if text is not None else "## PROGRESS\n"
    open_, close = f"<!-- ctu:{ds} -->", f"<!-- /ctu:{ds} -->"
    i = text.find(open_)
    if i >= 0:
        j = text.find(close, i)
        if j >= 0:
            j += len(close)
            lines = text[i:j].split("\n")
            nested = len(lines) > 1 and not lines[1].startswith("## ")
            body = (["#### Uygulama kaydı"] if nested else [header]) + entry
            return text[:i] + "\n".join([open_, *body, close]) + text[j:]
    m = re.search(rf"^## {re.escape(ds)}(?=[ \t]|$)[^\n]*\n?", text, re.M)
    if m:
        # A section for this date without markers. If it is the app's own old format ("- Saat:" right under
        # the header), replace that run of lines; otherwise it's hand-written: keep it and add the app's
        # record at its end, under it, so the date still has a single "## " heading.
        rest = text[m.end():]
        if rest.startswith("- Saat:"):
            k = 0
            for line in rest.splitlines(keepends=True):
                if not line.strip() or line.startswith("#") or not (line.startswith("- ") or line.startswith("  ")):
                    break
                k += len(line)
            block = "\n".join([open_, header, *entry, close]) + "\n"
            return text[:m.start()] + block + rest[k:]
        nxt = re.search(r"^## ", rest, re.M)
        cut = m.end() + (nxt.start() if nxt else len(rest))
        section = text[:cut].rstrip("\n")
        block = "\n".join([open_, "#### Uygulama kaydı", *entry, close])
        return section + "\n\n" + block + "\n\n" + text[cut:].lstrip("\n")
    return text.rstrip("\n") + "\n\n" + "\n".join([open_, header, *entry, close]) + "\n"


def write_progress(ds: str) -> None:
    entry = _progress_entry(ds)
    files.rewrite(STUDY_REPO / "PROGRESS.md", lambda old: progress_text(old, ds, entry), action=f"progress {ds}")


# ------------------------------------------------------------------ COACH.md (append only)
PROTECTED_HEADINGS = ("## Geçme eşikleri", "## Haftalık şablon")


def _protected_hash(text: str) -> str:
    """Hash of the threshold and weekly-schedule sections, which only the user changes."""
    parts = []
    for h in PROTECTED_HEADINGS:
        m = re.search(rf"^{re.escape(h)}.*?(?=^## |\Z)", text, re.M | re.S)
        parts.append(m.group(0) if m else f"<missing {h}>")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def _check_protected(text: str) -> None:
    h = _protected_hash(text)
    seen = db.kv_get("coach_protected")
    if seen and seen["hash"] != h:
        health.warn("coach_protected", "The thresholds or weekly schedule section in COACH.md changed since "
                                       f"{seen['ts'][:16].replace('T', ' ')}. If you didn't change it yourself, check the file.")
    if not seen or seen["hash"] != h:
        db.kv_set("coach_protected", {"hash": h, "ts": db.ts()})


def append_coach_log(text: str, heading: str | None = None) -> bool:
    """Add one line to the end of COACH.md, tagged with the date and the app. Never rewrites the file.
    `heading` (e.g. '### Hafta 1 — ...') is added first if the file doesn't have it yet.
    A custom plan has no COACH.md: its log is kept in the database and written out to PLAN.md."""
    if not profile.is_ctu():
        planlog.add(text, heading.lstrip("# ") if heading else None)
        return True
    if not COACH_MD.exists():
        health.warn("coach_missing", f"COACH.md not found at {COACH_MD}; the coach log line was not written.")
        return False
    health.clear("coach_missing")
    before = COACH_MD.read_text()
    _check_protected(before)
    line = " ".join(text.split())[:500]
    out = f"- [ctu-app {today().isoformat()}] {line}\n"
    if heading and not re.search(rf"^{re.escape(heading.split(' — ')[0])}\b", before, re.M):
        out = f"\n{heading}\n" + out
    files.append(COACH_MD, out, action="coach log")
    after = COACH_MD.read_text()
    if not after.startswith(before.rstrip("\n")):
        health.warn("coach_concurrent", "COACH.md changed while the app was appending to it; check the end of the file.")
    _check_protected(after)
    return True


def _weekly_summary(ds: str) -> None:
    d = date.fromisoformat(ds)
    w = week_index(d)
    start = week_start() + timedelta(days=7 * w)
    end = start + timedelta(days=6)
    secs = db.q1("SELECT IFNULL(SUM(spent_sec),0) s FROM tasks WHERE date BETWEEN ? AND ?", (start.isoformat(), ds))["s"]
    done = db.q1("SELECT COUNT(*) c FROM tasks WHERE date BETWEEN ? AND ? AND status='done'", (start.isoformat(), ds))["c"]
    total = db.q1("SELECT COUNT(*) c FROM tasks WHERE date BETWEEN ? AND ?", (start.isoformat(), ds))["c"]
    scores = db.q("SELECT item,value,max,passed FROM scores WHERE date BETWEEN ? AND ?", (start.isoformat(), ds))
    if not profile.is_ctu():
        sc = "; ".join(f"{s['item']} {s['value']:g}/{s['max']:g}" for s in scores) or "none"
        n = profile.week_no(w)
        append_coach_log(f"Week {n} summary ({ds}): {secs // 3600} h {secs % 3600 // 60} min studied, {done}/{total} "
                         f"tasks done. Scores: {sc}.", heading=f"Week {n} — {start.isoformat()} to {end.isoformat()}")
        return
    sc = "; ".join(f"{s['item']} {s['value']:g}/{s['max']:g}" for s in scores) or "yok"
    months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
    span = (f"{start.day}–{end.day} {months[end.month - 1]} {end.year}" if start.month == end.month
            else f"{start.day} {months[start.month - 1]} – {end.day} {months[end.month - 1]} {end.year}")
    if not append_coach_log(f"Uygulama özeti (Hafta {w}, {ds}): {_fmt_min(secs)} çalışma, {done}/{total} görev bitti. "
                            f"Puanlar: {sc}.", heading=f"### Hafta {w} — {span}"):
        raise RuntimeError("COACH.md not found, weekly summary not written")


# ------------------------------------------------------------------ closing a day
# A close runs in steps. The database part is one transaction; every later step (files, backup, model
# calls) is recorded in kv "close_jobs" and retried by the tick loop if it fails, so a failure never leaves
# the plan half-built without anyone noticing.
RETRY_AFTER_MIN = 10
MAX_ATTEMPTS = 6


def _jobs() -> dict:
    return db.kv_get("close_jobs", {}) or {}


def _set_job(ds: str, job: dict | None) -> None:
    jobs = _jobs()
    if job is None:
        jobs.pop(ds, None)
    else:
        jobs[ds] = job
    db.kv_set("close_jobs", jobs)


def close_jobs() -> dict:
    return _jobs()


def _close_core(ds: str, auto: bool) -> bool:
    """Database part of closing: timers stopped, day closed, unfinished work carried over. All or nothing."""
    d = date.fromisoformat(ds)
    with db.tx():
        row = db.q1("SELECT status FROM days WHERE date=?", (ds,))
        if not row or row["status"] == "closed":
            return False
        for t in db.q("SELECT * FROM tasks WHERE date=? AND status='doing'", (ds,)):
            state._stop(t)
        db.ex("UPDATE days SET status='closed' WHERE date=?", (ds,))
        state.log_event("day_closed", None, {"auto": auto}, d=d)
        _carry_over(ds)
        steps = (["progress"] if profile.is_ctu() or profile.has("repo") else []) + \
            (["weekly"] if d.weekday() == 6 else []) + ["backup", "adapt", "horizon"]
        _set_job(ds, {"pending": steps, "errors": {}, "attempts": 0, "last_try": None, "auto": auto})
    bus.publish("plan", {"date": ds, "closed": True})
    return True


async def _step(ds: str, step: str) -> None:
    if step == "progress":
        write_progress(ds)
    elif step == "weekly":
        _weekly_summary(ds)
    elif step == "backup":
        await asyncio.to_thread(db.backup, ds)
    elif step == "adapt":
        if not profile.is_ctu():
            _retakes_after(ds)
            return
        nxt = db.q1("SELECT date FROM days WHERE date>? AND status='planned' ORDER BY date LIMIT 1", (ds,))
        if nxt:
            await _adapt_day(nxt["date"])
    elif step == "horizon":
        await _ensure_horizon()


async def _run_steps(ds: str, only_fast: bool = False) -> None:
    job = _jobs().get(ds)
    if not job:
        return
    job["attempts"] += 1
    job["last_try"] = db.ts()
    for step in list(job["pending"]):
        if only_fast and step in ("adapt", "horizon"):
            continue
        bus.publish("close", {"date": ds, "step": step})
        try:
            await _step(ds, step)
        except Exception as e:  # noqa: BLE001 - recorded, shown, retried
            log.exception("closing %s: step %s failed", ds, step)
            job["errors"][step] = f"{type(e).__name__}: {e}"[:300]
            health.warn(f"close_{ds}", f"Closing {ds}: '{step}' failed ({job['errors'][step]}). "
                                       f"It will be retried in {RETRY_AFTER_MIN} min.")
            bus.publish("close", {"date": ds, "step": step, "error": job["errors"][step]})
            continue
        job["pending"].remove(step)
        job["errors"].pop(step, None)
        _set_job(ds, job)
    if not job["pending"]:
        _set_job(ds, None)
        health.clear(f"close_{ds}")
        bus.publish("close", {"date": ds, "done": True})
        from . import notices
        notices.safe_add("close", f"Day {ds} closed", "The next days are planned from today's results.", tone="ok", link=f"#/day/{ds}")
    else:
        _set_job(ds, job)
        if job["attempts"] >= MAX_ATTEMPTS and job["errors"]:
            health.warn(f"close_{ds}", f"Closing {ds} gave up after {job['attempts']} tries: "
                                       + "; ".join(f"{k}: {v}" for k, v in job["errors"].items()))
    bus.publish("plan", {"date": ds})


async def close_day(ds: str, auto: bool = False) -> None:
    async with _lock:
        if _close_core(ds, auto):
            await _run_steps(ds)


def close_overdue_now() -> list[str]:
    """At startup, before the UI is served: close every past day still open (database part and file steps).
    The model steps run later in the background; they never rebuild a day the user has started."""
    closed = []
    for d in db.q("SELECT date FROM days WHERE status='planned' AND date<? ORDER BY date", (today().isoformat(),)):
        if _close_core(d["date"], auto=True):
            closed.append(d["date"])
    return closed


async def resume_closes(force: bool = False) -> None:
    """Run what is left of earlier closes (a crash, a failed write, a model error), with a pause between tries."""
    async with _lock:
        for ds, job in sorted(_jobs().items()):
            if job["attempts"] >= MAX_ATTEMPTS and not force:
                continue
            last = job.get("last_try")
            if not force and last and now() - datetime.fromisoformat(last) < timedelta(minutes=RETRY_AFTER_MIN):
                continue
            await _run_steps(ds)

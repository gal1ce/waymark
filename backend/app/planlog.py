"""A custom plan's coach log and its PLAN.md.

The plan itself lives in the database (kv 'plan'); PLAN.md is written from it, in the data folder, so the plan can be
read, diffed or shared as a plain file. The app regenerates it whenever the plan or its log changes, so edits made in
the file are overwritten: the plan changes in the app, with the user's approval.

The CTU plan keeps its approved COACH.md log instead (planner.append_coach_log)."""
from __future__ import annotations

import logging
from pathlib import Path

from . import db, files, profile
from .config import DATA_DIR, WEEKDAY_TR

log = logging.getLogger("ctu.planlog")


def path() -> Path:
    return DATA_DIR / "PLAN.md"


def add(text: str, heading: str | None = None) -> None:
    line = " ".join((text or "").split())[:500]
    if not line:
        return
    db.ex("INSERT INTO plan_log (ts, heading, text) VALUES (?, ?, ?)", (db.ts(), heading, line))
    write()


def entries(limit: int = 400) -> list[dict]:
    return db.q("SELECT ts, heading, text FROM plan_log ORDER BY id DESC LIMIT ?", (limit,))[::-1]


def _md(s: str) -> str:
    return " ".join(str(s or "").split()).replace("|", "\\|")


def render(plan: dict, log_rows: list[dict], progress: list[dict] | None = None) -> str:
    out = [f"# {_md(plan.get('label') or 'Study plan')}", "",
           "_Written by Waymark from its database. Edits made here are overwritten; change the plan in the app "
           "(Settings → Plan)._", ""]
    if plan.get("summary"):
        out += [plan["summary"].strip(), ""]
    out += [f"- Start: {plan.get('start_date') or '—'}"]
    if plan.get("end_date"):
        out.append(f"- Last unit (at approval, every unit check passed first time): {plan['end_date']}")
    if plan.get("deadline"):
        out.append(f"- Deadline: {plan['deadline']}")
    if plan.get("approved_at"):
        out.append(f"- Approved: {plan['approved_at'][:10]}")
    out.append("")
    if plan.get("goals"):
        out += ["## Goals", ""]
        out += [f"- **{_md(g.get('label'))}**: {_md(g.get('target'))}" + (f" ({_md(g['note'])})" if g.get("note") else "")
                for g in plan["goals"]]
        out.append("")
    thr = plan.get("thresholds") or {}
    if thr:
        out += ["## Pass marks", "", "Nothing below its mark counts as learned.", ""]
        for v in thr.values():
            mark = f"{v.get('threshold')}/{v['max']}" if v.get("max") else f"{v.get('threshold')}{v.get('unit', '')}"
            out.append(f"- {_md(v.get('label'))}: {mark}")
        out.append("")
    out += ["## Weekly schedule", "", "| Day | Blocks |", "|---|---|"]
    days = set(plan.get("study_weekdays") or [])
    for i, blocks in enumerate(plan.get("week") or []):
        if i not in days:
            out.append(f"| {WEEKDAY_TR[i]} | off |")
            continue
        cells = ", ".join(f"{b['start']}–{b['end']} {_md(b['title'])}" for b in blocks)
        out.append(f"| {WEEKDAY_TR[i]} | {cells} |")
    out.append("")
    marks = {"passed": "[x]", "tried": "[~]", "current": "[>]", "planned": "[ ]", "todo": "[ ]"}
    state = {p["key"]: p for p in progress or []}
    for tr in plan.get("tracks") or []:
        out += [f"## {_md(tr['label'])}", ""]
        if tr.get("goal"):
            out += [_md(tr["goal"]), ""]
        st = {u["idx"]: u for u in state.get(tr["key"], {}).get("units", [])}
        for i, u in enumerate(tr.get("units") or []):
            s = st.get(i, {}).get("status", "planned")
            line = f"- {marks.get(s, '[ ]')} {i + 1}. {_md(u['title'])}"
            if u.get("objective"):
                line += f": {_md(u['objective'])}"
            out.append(line)
            for r in u.get("resources") or []:
                out.append(f"  - [{_md(r.get('label') or r.get('href'))}]({r.get('href')})")
        out.append("")
    if log_rows:
        out += ["## Log", ""]
        last = None
        for r in log_rows:
            if r["heading"] and r["heading"] != last:
                out += ["", f"### {_md(r['heading'])}", ""]
                last = r["heading"]
            out.append(f"- [{r['ts'][:10]}] {_md(r['text'])}")
        out.append("")
    return "\n".join(out).rstrip("\n") + "\n"


def write() -> Path | None:
    """Writes PLAN.md for a custom plan; the CTU plan and a new install have none."""
    if profile.key() != "custom" or not profile.ready():
        return None
    from . import tracks
    text = render(profile.active(), entries(), tracks.progress())
    p = path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        files.rewrite(p, lambda _old: text, action="PLAN.md")
    except OSError:
        log.exception("PLAN.md could not be written")
        return None
    return p

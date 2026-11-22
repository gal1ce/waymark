"""A short lesson for a study task, so a student who is behind can start without leaving the app. It teaches the
unit's idea with an example that is NOT one of the task's own problems (rule 1: the coach never solves the user's
work), and points to the part of the task's source to read next."""
from __future__ import annotations

from . import llm, profile

SYSTEM = """You are the user's study coach and you write a SHORT lesson (350–550 words) that starts a study session. Write in ENGLISH. Markdown with these headings, in this order:
## The idea
Two to four plain sentences: what this is and why it matters, before any symbols.
## Definitions
The precise statements the unit needs, each with one sentence saying what it means.
## Worked example
One fully worked example, step by step, each step with its reason. It must NOT be one of the problems the task asks the user to solve; pick a different, simpler one of the same kind.
## Common mistakes
Two or three, each with how to notice it.
## Read next
Which part of the task's sources to read (chapter or section by name). Use a link only if it is given below; never invent a URL.
## Check yourself
Two short questions the user answers alone (no answers here; the coach checks them).

Math in LaTeX between $...$ or $$...$$ (always with the backslash: \\varepsilon, \\delta, \\frac{a}{b}). No code that solves an exercise."""


async def write(task: dict, tr: dict) -> str:
    units = tr.get("units") or []
    m = task.get("meta") or {}
    u = units[m["unit"]] if isinstance(m.get("unit"), int) and m["unit"] < len(units) else {}
    a = profile.active().get("answers") or {}
    src = "; ".join(r["label"] + (f" <{r['href']}>" if r.get("href") else "") for r in task.get("resources") or []) or "none given"
    prompt = (f"Course: {tr['label']}\nUnit: {u.get('title', task['title'])}\nObjective: {u.get('objective', '')}\n"
              f"Task: {task['title']}\n{task.get('detail', '')}\nIts problems (do NOT solve these): {u.get('practice', '')}\n"
              f"Sources: {src}\nThe student: {a.get('level') or 'not said'}; {a.get('background') or 'background not said'}")
    resp = await llm.create(system=SYSTEM, messages=[{"role": "user", "content": prompt}], effort="medium", max_tokens=4000)
    text = "".join(getattr(b, "text", "") for b in resp.content).strip()
    if not text:
        raise RuntimeError("The model returned no lesson.")
    return text[:12000]

"""The frame of the study plan the app runs: who it is for, the goal, the study days and hours, the blocks, the pass
marks and the plan-specific parts of the prompts. The rest of the app reads these from here instead of hardcoding them.

Which plan is active is stored in the database (profile.preset):
- 'ctu'    the plan the app was first built for (app/presets/ctu.py), run by the built-in CTU curriculum;
- 'custom' a plan drafted from the onboarding answers and approved by the user, kept in kv 'plan' and run by the
           generic tracks planner (app/tracks.py);
- None     a new install that hasn't been set up yet: no study days until onboarding is finished.

Everything is read through functions, never copied into module constants, so approving a new plan takes effect
without a restart. Callers must not change the dicts they get back (use week() for a copy)."""
from __future__ import annotations

import copy
import re
from datetime import date

from .presets import ctu

PRESETS: dict[str, dict] = {"ctu": ctu.PRESET}

# What a new, not yet set up install runs: nothing is planned until onboarding is done.
EMPTY: dict = {
    "key": None, "engine": None, "label": "", "start_date": None, "study_weekdays": [], "week": [[] for _ in range(7)],
    "block_min": {}, "block_cap": {}, "thresholds": {}, "goals": [], "topics": [], "modules": [], "tracks": [],
    "coach": {"intro": "You are the user's study coach inside their study app. The user hasn't set up a study plan "
                       "yet; help them finish setting it up (Settings → Plan).",
              "learning_work": "problem sets, exercises, proofs, summaries and essays",
              "thresholds": "There are no pass marks yet: the plan isn't set up.", "context": "no plan yet."},
    "planner": {"frame": "", "rules": ""}, "eod_rules": "", "practice_rules": "",
}

_cache: dict | None = None


def reload() -> None:
    """Forget the cached plan; the next read loads it from the database again (after onboarding or a restore)."""
    global _cache
    _cache = None


def key() -> str | None:
    """'ctu', 'custom' or None (not set up)."""
    from . import db
    r = db.q1("SELECT preset FROM profile WHERE id=1")
    k = r["preset"] if r else None
    return k if k in ("ctu", "custom") else None


def _load() -> dict:
    from . import db
    k = key()
    if k == "custom":
        plan = db.kv_get("plan")
        if isinstance(plan, dict) and plan.get("week"):
            return plan
        return EMPTY
    return PRESETS.get(k or "", EMPTY)


def active() -> dict:
    global _cache
    if _cache is None:
        _cache = _load()
    return _cache


def ready() -> bool:
    """True when there is a plan to run (the CTU plan, or an approved custom one)."""
    return bool(active().get("study_weekdays"))


def engine() -> str | None:
    """Which planner fills the days: 'ctu' (the built-in CTU curriculum) or 'tracks' (a custom plan)."""
    a = active()
    return a.get("engine") or ("ctu" if a.get("key") == "ctu" else None)


def is_ctu() -> bool:
    return engine() == "ctu"


def week_no(w: int) -> int:
    """A week index (0 = the plan's first week) as people read it: the CTU plan calls its first week "Week 0" (its
    notes do), every other plan "Week 1". The UI counts the same way (weekNo in api.ts)."""
    return w + (0 if key() == "ctu" else 1)


def modules() -> list[str]:
    """The content modules this plan uses (see app/modules.py)."""
    return list(active().get("modules") or [])


def has(module: str) -> bool:
    return module in modules()


def start_date() -> date:
    s = active().get("start_date")
    if s:
        return date.fromisoformat(s)
    from .config import today
    return today()


def study_weekdays() -> set[int]:
    return set(active().get("study_weekdays") or [])


def week(weekday: int) -> list[dict]:
    """The blocks of a weekday (0 = Monday), as copies the caller may change."""
    w = active().get("week") or []
    return copy.deepcopy(w[weekday]) if weekday < len(w) else []


def thresholds() -> dict:
    return active().get("thresholds") or {}


def goals() -> list[dict]:
    return active().get("goals") or []


def block_min() -> dict:
    return active().get("block_min") or {}


def block_cap() -> dict:
    return active().get("block_cap") or {}


def tracks() -> list[dict]:
    return active().get("tracks") or []


def track(k: str) -> dict | None:
    return next((t for t in tracks() if t.get("key") == k), None)


def topics() -> list[tuple[str, re.Pattern]]:
    out = []
    for t in active().get("topics") or []:
        try:
            out.append((t["name"], re.compile(t["pattern"], re.I if "i" in t.get("flags", "") else 0)))
        except re.error:
            continue
    return out

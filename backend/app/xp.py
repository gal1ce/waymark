"""Experience points, derived from what's already recorded (finished tasks, Khan answers, tests, closed days).
Nothing is stored: the same data always gives the same total, and XP can't drift from the real work."""
from __future__ import annotations

from datetime import timedelta

from . import db, profile
from .config import today

TASK = 20               # a finished task
KHAN_FIRST_TRY = 5      # a practice question right on the first try, without a hint
KHAN_COUNTED = 1        # any other counted practice question: showing up counts a little
KHAN_MASTERED = 25      # an exercise mastered
TEST_CORRECT = 10       # per correct answer in a submitted test (end of day, C quiz, practice)
UNIT_PASSED = 100       # a Khan unit test at or above the threshold
UNIT_TRIED = 20         # a Khan unit test below it
DAY_CLOSED = 30         # a study day closed


def unit_threshold() -> float:
    """Percent, the pass mark for a Khan unit test."""
    return (profile.thresholds().get("khan_unit") or {}).get("threshold", 90)


def level_for(total: int) -> dict:
    """Level n needs 100·n·(n+1)/2 XP in total: 100, 300, 600, 1000 ..."""
    n = 0
    while 100 * (n + 1) * (n + 2) // 2 <= total:
        n += 1
    lo, hi = 100 * n * (n + 1) // 2, 100 * (n + 1) * (n + 2) // 2
    return {"level": n + 1, "into": total - lo, "span": hi - lo}


def _gains() -> list[dict]:
    """Every gain with its time, newest first."""
    out: list[dict] = []
    for r in db.q("SELECT title, done_at, date FROM tasks WHERE status='done'"):
        out.append({"ts": r["done_at"] or r["date"], "date": r["date"], "xp": TASK, "label": r["title"], "kind": "task"})
    for r in db.q("SELECT ts, date, correct, hinted FROM khan_attempts WHERE mode='practice'"):
        good = r["correct"] and not r["hinted"]
        out.append({"ts": r["ts"], "date": r["date"], "xp": KHAN_FIRST_TRY if good else KHAN_COUNTED,
                    "label": "Khan question, first try" if good else "Khan question", "kind": "khan"})
    for r in db.q("SELECT mastered_at FROM khan_mastery"):
        out.append({"ts": r["mastered_at"], "date": r["mastered_at"][:10], "xp": KHAN_MASTERED,
                    "label": "Exercise mastered", "kind": "mastery"})
    for r in db.q("SELECT date, kind, score, submitted_at FROM tests WHERE status='submitted' AND score IS NOT NULL"):
        n = int(round(r["score"] or 0))
        if n > 0:
            out.append({"ts": r["submitted_at"] or r["date"], "date": r["date"], "xp": TEST_CORRECT * n,
                        "label": f"{n} right in a test", "kind": "test"})
    for r in db.q("SELECT date, submitted_at, score FROM khan_tests WHERE status='submitted' AND score IS NOT NULL"):
        passed = (r["score"] or 0) >= unit_threshold()
        out.append({"ts": r["submitted_at"] or r["date"], "date": r["date"], "xp": UNIT_PASSED if passed else UNIT_TRIED,
                    "label": "Unit test passed" if passed else "Unit test taken", "kind": "unit"})
    for r in db.q("SELECT date FROM days WHERE status='closed' AND kind='study'"):
        out.append({"ts": r["date"] + "T23:59:00", "date": r["date"], "xp": DAY_CLOSED, "label": "Day closed", "kind": "day"})
    out.sort(key=lambda g: g["ts"] or "", reverse=True)
    return out


def summary() -> dict:
    gains = _gains()
    total = sum(g["xp"] for g in gains)
    t = today()
    td = t.isoformat()
    week0 = (t - timedelta(days=6)).isoformat()
    by_day: dict[str, int] = {}
    for g in gains:
        if g["date"] >= week0:
            by_day[g["date"]] = by_day.get(g["date"], 0) + g["xp"]
    return {
        "total": total,
        "today": by_day.get(td, 0),
        "week": [{"date": (t - timedelta(days=i)).isoformat(), "xp": by_day.get((t - timedelta(days=i)).isoformat(), 0)}
                 for i in range(6, -1, -1)],
        **level_for(total),
        "recent": gains[:12],
    }

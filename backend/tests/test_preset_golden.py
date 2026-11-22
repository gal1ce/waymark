"""The CTU plan, frozen. Everything the plan's frame decides (days, hours, blocks, pass marks, goals, the plan-specific
parts of the prompts, the days the planner builds) is compared with a snapshot taken before the frame moved out of the
code into the `ctu` preset. A difference means the user's own plan changed.

Regenerate only on purpose, after the user approved a plan change: CTU_GOLDEN_WRITE=1 uv run pytest tests/test_preset_golden.py"""
from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

from app import db

GOLDEN = Path(__file__).with_name("golden") / "ctu_preset.json"
ALL_PHASES = ["c_ds", "kintsugi_rewrite", "khan_geometry"]
CURSORS = {
    "start": {"khan_unit": 0, "beej_next": 6, "kintsugi_idx": 1, "quiz_from": 2, "essay_n": 0, "eng_c": 0, "eng_k": 0},
    "mid": {"khan_unit": 7, "beej_next": 10, "kintsugi_idx": 4, "quiz_from": 8, "essay_n": 3, "eng_c": 2, "eng_k": 1},
    "end": {"khan_unit": 99, "beej_next": 99, "kintsugi_idx": 99, "quiz_from": 12, "essay_n": 9, "eng_c": 7, "eng_k": 5,
            "ds_idx": 5, "rewrite_idx": 4},
}


def _jsonable(x):
    return json.loads(json.dumps(x, default=lambda o: sorted(o) if isinstance(o, (set, frozenset)) else str(o)))


def snapshot() -> dict:
    from app import config, curriculum, insights, planner, profile, prompts, seed, xp
    d0 = date(2026, 11, 23)
    out: dict = {
        "config": {
            "start": config.start_date().isoformat(), "weekdays": sorted(config.study_weekdays()),
            "next_study": [config.next_study_day(d0 + timedelta(days=i)).isoformat() for i in range(14)],
            "week_index": [config.week_index(d0 + timedelta(days=i)) for i in range(0, 40, 3)],
        },
        "schedule": [curriculum.schedule(w) for w in range(7)],
        "thresholds": profile.thresholds(),
        "block_min": profile.block_min(), "block_cap": profile.block_cap(),
        "prompts": {"coach": prompts.coach_system(), "planner": prompts.planner_system(), "eod": prompts.eod_system(),
                    "quiz": prompts.quiz_system(), "practice": prompts.practice_system()},
        "goals": insights.goals(),
        "topics": [[k, p.pattern, int(p.flags)] for k, p in profile.topics()],
        "xp": {k: getattr(xp, k) for k in ("TASK", "KHAN_FIRST_TRY", "KHAN_COUNTED", "KHAN_MASTERED", "TEST_CORRECT",
                                            "UNIT_PASSED", "UNIT_TRIED", "DAY_CLOSED")} | {"UNIT_THRESHOLD": xp.unit_threshold()},
        "seed": {"mon": seed.monday(), "tue": seed.tuesday(), "wed": seed.wednesday(), "fallback": seed.FALLBACK_TESTS},
    }
    seed.seed_if_empty()
    out["seeded"] = {
        "days": db.q("SELECT date, week, kind, version, status, title FROM days ORDER BY date"),
        "blocks": db.q("SELECT date, ord, start, end, kind, title FROM blocks ORDER BY date, ord"),
        "tasks": db.q("SELECT date, ord, title, detail, kind, learning, resources, files, est_min, meta FROM tasks "
                      "ORDER BY date, block_id, ord"),
    }
    days, runways = {}, {}
    for phases in ([], ALL_PHASES):
        db.kv_set("approved_phases", phases)
        tag = "+".join(phases) or "base"
        for name, cur in CURSORS.items():
            for i in range(7):
                d = date(2026, 11, 30) + timedelta(days=i)
                days[f"{tag}/{name}/{d}"] = planner.template_day(d, dict(cur))
            runways[f"{tag}/{name}"] = curriculum.runway(dict(cur), d0, config.next_study_day, approved=set(phases))
    # a failed unit test turns the morning into study + retake
    db.ex("INSERT INTO scores (ts, date, kind, item, value, max, threshold, passed) VALUES (?,?,?,?,?,?,?,?)",
          ("2026-11-30T12:00:00", "2026-11-30", "khan_unit", curriculum.khan_item(7), 60, 100, 90, 0))
    db.kv_set("approved_phases", [])
    days["retake/mid/2026-12-01"] = planner.template_day(date(2026, 12, 1), dict(CURSORS["mid"]))
    out["template_day"] = days
    out["runway"] = runways
    return _jsonable(out)


def test_ctu_plan_is_unchanged(fresh):
    got = snapshot()
    if os.environ.get("CTU_GOLDEN_WRITE") == "1":
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(json.dumps(got, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    want = json.loads(GOLDEN.read_text())
    for key in sorted(set(want) | set(got)):
        if isinstance(want.get(key), dict) and isinstance(got.get(key), dict):
            for sub in sorted(set(want[key]) | set(got[key])):
                assert got[key].get(sub) == want[key].get(sub), f"the CTU plan changed: {key}/{sub}"
        assert got.get(key) == want.get(key), f"the CTU plan changed: {key}"


def test_preset_is_plain_data():
    """A preset must survive a trip through JSON unchanged: onboarding will store the same shape in the database."""
    from app.presets import ctu
    assert json.loads(json.dumps(ctu.PRESET)) == ctu.PRESET

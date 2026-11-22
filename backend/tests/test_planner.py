"""Closing days, rebuilding the next one, carry-over, the cursor and the curriculum running out."""
from __future__ import annotations

import asyncio
import json
from datetime import date

import pytest

from app import db, health, planner, state
from app.curriculum import BEEJ_LAST, KINTSUGI_ORDER
from conftest import ROOT, set_now


def _first_task(ds: str, kind: str | None = None) -> dict:
    sql = "SELECT * FROM tasks WHERE date=?" + (" AND kind=?" if kind else "") + " ORDER BY id LIMIT 1"
    return db.q1(sql, (ds, kind) if kind else (ds,))


def test_morning_close_keeps_todays_started_work(seeded):
    """#1: yesterday left open; the user starts a task today; closing yesterday must not rebuild today."""
    set_now("2026-11-24T10:00")
    t = _first_task("2026-11-24")
    state.start_task(t["id"])
    set_now("2026-11-24T10:20")
    assert planner.close_overdue_now() == ["2026-11-23"]
    asyncio.run(planner.resume_closes(force=True))
    after = db.q1("SELECT * FROM tasks WHERE id=?", (t["id"],))
    assert after is not None, "today's started task was deleted"
    assert after["status"] == "doing" and after["first_started_at"]
    assert db.q1("SELECT status FROM days WHERE date='2026-11-23'")["status"] == "closed"
    assert not planner.close_jobs()


def test_untouched_next_day_is_still_adapted(seeded):
    set_now("2026-11-23T21:50")
    asyncio.run(planner.close_day("2026-11-23"))
    assert db.q1("SELECT version FROM days WHERE date='2026-11-24'")["version"] == "adapted"


def test_touched_detects_scores_and_tests(seeded):
    assert not planner.touched("2026-11-24")
    db.ex("INSERT INTO tests(date,kind,status,created_at) VALUES('2026-11-24','eod','ready','x')")
    assert planner.touched("2026-11-24")


def test_close_is_atomic_and_failures_are_retried(seeded, monkeypatch):
    """#5: a failing file step leaves the day closed and carried over, records the error, retries later."""
    set_now("2026-11-23T21:50")
    calls = {"n": 0}
    real = planner.write_progress

    def broken(ds):
        calls["n"] += 1
        raise OSError("disk full")

    monkeypatch.setattr(planner, "write_progress", broken)
    asyncio.run(planner.close_day("2026-11-23"))
    assert db.q1("SELECT status FROM days WHERE date='2026-11-23'")["status"] == "closed"
    job = planner.close_jobs()["2026-11-23"]
    assert job["pending"] == ["progress"] and "disk full" in job["errors"]["progress"]
    assert "close_2026-11-23" in health.warnings()
    # carry-over and the rest of the steps still ran
    assert db.q1("SELECT 1 FROM tasks WHERE date='2026-11-24' AND meta LIKE '%carried_from%'")
    monkeypatch.setattr(planner, "write_progress", real)
    asyncio.run(planner.resume_closes())          # too soon: waits RETRY_AFTER_MIN
    assert "2026-11-23" in planner.close_jobs()
    asyncio.run(planner.resume_closes(force=True))
    assert not planner.close_jobs()
    assert "close_2026-11-23" not in health.warnings()
    assert "<!-- ctu:2026-11-23 -->" in (ROOT / "repo" / "PROGRESS.md").read_text()


def test_close_core_rolls_back_on_error(seeded, monkeypatch):
    set_now("2026-11-23T21:50")
    monkeypatch.setattr(planner, "_carry_over", lambda ds: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        planner._close_core("2026-11-23", auto=False)
    assert db.q1("SELECT status FROM days WHERE date='2026-11-23'")["status"] == "planned"
    assert not db.q1("SELECT 1 FROM events WHERE type='day_closed'")


def test_generate_reference_never_leaves_an_empty_day(seeded, monkeypatch):
    def broken(d, plan):
        db.ex("DELETE FROM tasks WHERE date=?", (d.isoformat(),))
        raise RuntimeError("crash mid-insert")

    monkeypatch.setattr(planner, "insert_tasks", broken)
    with pytest.raises(RuntimeError):
        asyncio.run(planner._generate_reference(date(2026, 11, 29)))
    assert not db.q1("SELECT 1 FROM days WHERE date='2026-11-29'")
    cur = db.kv_get("cursor")
    assert cur["kintsugi_idx"] == 1   # cursor didn't move either


def test_horizon_refills_an_empty_planned_day(seeded):
    db.ex("DELETE FROM tasks WHERE date='2026-11-25'")
    set_now("2026-11-24T09:00")
    asyncio.run(planner.ensure_horizon())
    assert db.q1("SELECT COUNT(*) c FROM tasks WHERE date='2026-11-25'")["c"] > 0


def test_parallel_horizon_runs_move_the_cursor_once(seeded):
    """Inferred risk: two planners at once must not plan the same day twice and skip material."""
    set_now("2026-11-25T09:00")

    async def both():
        await asyncio.gather(planner.ensure_horizon(), planner.ensure_horizon())

    asyncio.run(both())
    days = [r["date"] for r in db.q("SELECT date FROM days ORDER BY date")]
    assert len(days) == len(set(days))
    sat = db.q("SELECT title FROM tasks WHERE date='2026-11-28' AND kind='kintsugi_read'")
    assert len(sat) > 0


def test_carry_over_moves_unfinished_evening_work(seeded):
    set_now("2026-11-23T21:50")
    asyncio.run(planner.close_day("2026-11-23"))
    moved = db.q("SELECT title, meta FROM tasks WHERE date='2026-11-25' AND meta LIKE '%carried_from%'")
    assert moved and all(json.loads(m["meta"])["carried_from"] == "2026-11-23" for m in moved)
    caps = db.q("SELECT b.id, SUM(t.est_min) s FROM blocks b JOIN tasks t ON t.block_id=b.id "
                "WHERE b.kind='c' GROUP BY b.id")
    assert all(c["s"] <= 255 or c["s"] == max(c["s"] for c in caps) for c in caps)


def test_c_evenings_review_after_beej_12(seeded):
    """#10: past the last chapter the evening is a review, not empty."""
    cur = planner._cursor() | {"beej_next": BEEJ_LAST + 1}
    plan = planner.template_day(date(2026, 12, 2), cur)   # a Wednesday (C evening)
    assert plan["c"] and any(t["kind"] == "review" for t in plan["c"])
    assert sum(t["est_min"] for t in plan["c"]) <= 255


def test_kintsugi_evenings_review_after_last_group(seeded):
    cur = planner._cursor() | {"kintsugi_idx": len(KINTSUGI_ORDER)}
    plan = planner.template_day(date(2026, 12, 1), cur)   # a Tuesday (Kintsugi evening)
    assert plan["kintsugi"] and plan["kintsugi"][0]["kind"] == "review"


def test_runway_warns_before_material_runs_out(seeded):
    db.kv_set("cursor", planner._cursor() | {"beej_next": 11})
    r = planner.check_runway()
    assert r["c_days"] is not None and r["c_days"] < 7
    assert "runway_c_days" in health.warnings()


def test_khan_continues_into_algebra_2(seeded):
    first, second = planner._math_tasks(16)
    assert "Polynomial arithmetic" in first[0]["title"]


# ------------------------------------------------------------------ #14 plan filter
def _t(**kw):
    base = {"title": "x", "kind": "read", "est_min": 30, "detail": "", "resources": [], "files": [], "learning": 1, "meta": {}}
    return base | kw


def test_valid_rejects_unsafe_and_keeps_going():
    plan = {"math": [], "math2": [], "eng": [
        _t(kind="write", files=["../../.bashrc"]),
        _t(kind="write", files=["eng/ok.md"], resources=[{"label": "bad", "kind": "url", "href": "javascript:alert(1)"},
                                                       {"label": "good", "kind": "url", "href": "https://example.com"}]),
    ], "evening": [
        _t(kind="exercise", files=[]),
        _t(kind="exercise", files=["c/ch06/a.c"], est_min=300),     # over the block: dropped, not the rest
        _t(kind="exercise", files=["c/ch06/b.c"], est_min=60),
        _t(kind="read", files=["c/ch06/sneaky.c"]),
    ]}
    out = planner._valid(plan)
    assert [t["files"] for t in out["eng"]] == [["eng/ok.md"]]
    assert [r["label"] for r in out["eng"][0]["resources"]] == ["good"]
    assert [t["files"] for t in out["evening"]] == [["c/ch06/b.c"]]


# ------------------------------------------------------------------ #10 next phases (approval-gated)
def test_next_phases_are_off_until_approved(seeded):
    cur = planner._cursor() | {"beej_next": BEEJ_LAST + 1, "kintsugi_idx": len(KINTSUGI_ORDER)}
    assert all(not p["approved"] for p in planner.phases())
    wed, tue = planner.template_day(date(2026, 12, 2), cur), planner.template_day(date(2026, 12, 1), cur)
    assert any(t["kind"] == "review" for t in wed["c"]) and tue["kintsugi"][0]["kind"] == "review"
    assert "Algebra 2" not in planner._math_tasks(99)[0][0]["title"] and "Modeling" in planner._math_tasks(99)[0][0]["title"]


def test_approved_c_phase_builds_data_structures_and_usaco(seeded):
    planner.set_phase("c_ds", True)
    cur = planner._cursor() | {"beej_next": BEEJ_LAST + 1, "ds_idx": 0}
    wed = planner.template_day(date(2026, 12, 2), cur)["c"]
    assert [t["files"] for t in wed if t["kind"] == "exercise"] == [["c/ds/dynarray.c"]]
    assert planner._valid({"evening": wed})["evening"] == wed            # passes the plan filter
    sun = planner.template_day(date(2026, 12, 6), cur)["c"]
    assert any("USACO" in t["title"] for t in sun)
    planner._advance_cursor(date(2026, 12, 2), {"c": wed})
    assert planner._cursor()["ds_idx"] == 1
    assert "Plan: 'C data structures + USACO Bronze' onaylandı" in (ROOT / "COACH.md").read_text()


def test_approved_kintsugi_rewrite_and_geometry(seeded):
    planner.set_phase("kintsugi_rewrite", True)
    planner.set_phase("khan_geometry", True)
    cur = planner._cursor() | {"kintsugi_idx": len(KINTSUGI_ORDER), "rewrite_idx": 0}
    k = planner.template_day(date(2026, 12, 1), cur)["kintsugi"]
    assert k[0]["kind"] == "rewrite" and k[0]["files"] == ["cpp/kintsugi/rewrite/include/disk_manager.h"]
    assert planner._valid({"evening": k})["evening"] == k
    assert "Performing transformations" in planner._math_tasks(28)[0][0]["title"]


def test_runway_counts_approved_phases(seeded):
    db.kv_set("cursor", planner._cursor() | {"beej_next": BEEJ_LAST + 1})
    assert planner.check_runway()["c_days"] == 0
    planner.set_phase("c_ds", True)
    r = planner.check_runway()
    assert r["c_days"] is None or r["c_days"] >= 7
    assert "runway_c_days" not in health.warnings()
    planner.set_phase("c_ds", False)
    assert planner.check_runway()["c_days"] == 0

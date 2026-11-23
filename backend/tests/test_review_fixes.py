"""Fixes from a user test of a plan of one's own: the plan's questions come back filled in, the test block's task
fills its block, weeks are counted from 1, the plan says when its units end next to the deadline, locked days show
an outline, and the free Gemini mode retries a busy server. Nothing here goes to the network."""
from __future__ import annotations

import asyncio
from datetime import date

from app import db, onboarding, profile, state, tracks
from test_custom_plan import ANSWERS, H, _draft_and_approve, _fake_model, client, model_draft  # noqa: F401


def test_changing_the_plan_gets_the_approved_answers(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    plan = client.get("/api/plan").json()
    assert plan["answers"]["goal"] == ANSWERS["goal"] and plan["answers"]["weekdays"] == [0, 2, 4]
    assert plan["answers"]["hours"] == 6 and "plan_text" not in plan["answers"]


def test_the_end_of_day_test_fills_its_block(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    t = db.q1("SELECT t.est_min, t.detail, b.start, b.end FROM tasks t JOIN blocks b ON b.id=t.block_id "
              "WHERE t.kind='test' AND t.date='2026-11-25'")
    block = tracks._minutes({"start": t["start"], "end": t["end"]})
    close = 5 if profile.has("repo") else 0
    assert t["est_min"] == block - close and "30 min" in t["detail"]


def test_weeks_reach_the_model_counted_from_one_in_a_plan_of_ones_own(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    assert profile.week_no(0) == 1
    seen = []

    async def structured(system, prompt, schema, effort="medium", max_tokens=16000):
        seen.append(prompt)
        raise RuntimeError("no model in tests")
    monkeypatch.setattr(tracks.llm, "structured", structured)
    d = date(2026, 11, 30)                                   # week index 1: the plan's second week
    asyncio.run(tracks.llm_plan(d, tracks.template_day(d), ""))
    assert seen and "(week 2)" in seen[0]


def test_the_units_end_is_worked_out_from_the_schedule():
    week = [[{"kind": "a"}, {"kind": "test"}], [], [{"kind": "a"}, {"kind": "b"}], [], [], [], []]
    trs = [{"key": "a", "units": [{"sessions": 2}, {"sessions": 1}]}, {"key": "b", "units": [{"sessions": 2}]}]
    # a: Mon, Wed (×1 each): 3 sessions → Mon 30 Nov, Wed 2 Dec, Mon 7 Dec; b: Wed 2, Wed 9 Dec
    assert tracks.finish(week, trs, date(2026, 11, 30)) == date(2026, 12, 9)
    assert tracks.finish(week, trs, date(2026, 11, 30), {"a": {"unit": 1, "session": 0}, "b": {"unit": 0, "session": 1}}) \
        == date(2026, 12, 2)
    assert tracks.finish(week, [{"key": "c", "units": [{"sessions": 1}]}], date(2026, 11, 30)) is None  # never studied


def test_the_draft_names_its_end_and_flags_a_label_or_deadline_it_misses(client, monkeypatch):
    many = [{"title": f"U{i}", "objective": "x", "practice": "y", "sessions": 3, "resources": []} for i in range(12)]
    draft = model_draft(label="3-Week Intensive", deadline="2026-12-14",
                        tracks=[{"key": "analysis", "label": "Real analysis", "goal": "", "units": many},
                                {"key": "algo", "label": "Algorithms", "goal": "", "units": many[:2]}])
    _fake_model(monkeypatch, draft)
    client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, "deadline": ""}}, headers=H)
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    p = st["draft"]["plan"]
    assert p["deadline"] == "2026-12-14" and p["end_date"] > p["deadline"]
    assert p["answers"]["deadline"] == "2026-12-14"          # named by the model from the user's words
    assert any("after the deadline" in n for n in st["draft"]["notes"])
    assert any('called "3-Week Intensive"' in n for n in st["draft"]["notes"])
    assert "Deadline: 2026-12-14" in p["coach"]["context"]


def test_a_month_deadline_becomes_its_last_day(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)                  # ANSWERS has deadline 2027-09
    plan = client.get("/api/plan").json()
    assert plan["deadline"] == "2027-09-30" and plan["end_date"] and plan["projected_end"]
    cal = client.get("/api/calendar/2026-12").json()
    assert cal["deadline"] == "2027-09-30" and cal["end"] == plan["projected_end"]


def test_a_locked_day_shows_its_outline_but_no_tasks(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    stored = state.get_day("2026-11-27")
    assert stored["status"] == "locked" and "blocks" not in stored
    assert [b["track"] for b in stored["outline"]][:1] == ["Algorithms"]
    ahead = state.get_day("2026-11-30")                      # not planned yet: worked out from the cursor
    assert ahead["status"] == "locked" and ahead["outline"]
    assert all("detail" not in b for b in ahead["outline"]) and any(b["unit"] for b in ahead["outline"])
    assert state.get_day("2027-03-01")["outline"] is None    # too far ahead

"""Fixes from the fourth user test: the coach never calls a block "running" when no task is, programming follows a
change request, each course shows the review days before its exam, and a study task can have a lesson in the app.
Nothing here goes to the network."""
from __future__ import annotations

import asyncio
import json
from datetime import date

from app import agent, db, lessons, onboarding, tracks
from conftest import set_now
from test_custom_plan import ANSWERS, H, _draft_and_approve, _fake_model, client, model_draft  # noqa: F401


def test_no_task_running_means_the_coach_is_told_so_twice(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:10")
    status, _ = agent._status_block(None)
    assert "has not started one" in status and "Never say a task or block is running" in status
    today = agent._today_block()
    assert "<- NOW" not in today and "scheduled now by the clock (no task started in it)" in today


def test_a_change_request_can_turn_programming_on(client, monkeypatch):
    draft = model_draft()
    _fake_model(monkeypatch, {**draft, "programming": False})
    client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, "code": False,
                                                           "background": "I can write basic Python and C"}}, headers=H)
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    assert any("mention" in n and "Python" in n for n in st["draft"]["notes"])        # flagged, not silently dropped
    assert st["draft"]["plan"]["modules"] == []
    _fake_model(monkeypatch, {**draft, "programming": True})
    client.post("/api/onboarding/change", json={"change": "Include programming in Python and C"}, headers=H)
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    p = st["draft"]["plan"]
    assert p["modules"] == ["code"] and p["code_questions"] is True and p["answers"]["code"] is True
    assert any("Programming is now in the plan" in n for n in st["draft"]["notes"])
    assert st["answers"]["code"] is True                                               # the questions show it next time


def test_each_course_shows_when_its_units_end(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    plan = client.get("/api/plan").json()
    assert set(plan["track_ends"]) == {t["key"] for t in plan["tracks"]}
    week = [[{"kind": "a"}], [], [], [], [], [], []]
    trs = [{"key": "a", "label": "A", "units": [{"title": "U1", "sessions": 2}, {"title": "U2", "sessions": 1}]}]
    start = date(2026, 11, 30)
    assert tracks.track_ends(week, trs, start) == {"a": "2026-12-14"}
    assert tracks.track_ends(week, trs, start, {"a": {"unit": 1, "session": 0}}) == {"a": "2026-11-30"}


def test_review_after_the_units_points_at_the_exam():
    tr = {"key": "a", "label": "A", "deadline": "2026-12-10", "units": [{"title": "U1", "sessions": 1}]}
    t = tracks._block_tasks(tr, 45, {"unit": 1, "session": 0})[0]
    assert t["kind"] == "review" and "until its exam on 2026-12-10" in t["detail"] and t["meta"]["exam"] == "2026-12-10"
    t = tracks._block_tasks({**tr, "deadline": ""}, 45, {"unit": 1, "session": 0})[0]
    assert "Ask the coach to add the next units" in t["detail"] and "exam" not in t["meta"]


def test_a_study_task_gets_a_lesson_once(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:00")
    seen = []

    async def write(task, tr):
        seen.append(task["id"])
        return "## The idea\nA limit is where $f(x)$ heads."
    monkeypatch.setattr(lessons, "write", write)
    read = db.q1("SELECT id FROM tasks WHERE date='2026-11-25' AND kind='read' LIMIT 1")
    other = db.q1("SELECT id FROM tasks WHERE date='2026-11-25' AND kind<>'read' LIMIT 1")
    assert client.post(f"/api/tasks/{other['id']}/lesson", headers=H).status_code == 409
    r = client.post(f"/api/tasks/{read['id']}/lesson", headers=H).json()
    assert r["lesson"].startswith("## The idea")
    assert client.post(f"/api/tasks/{read['id']}/lesson", headers=H).json() == r and len(seen) == 1   # kept
    assert json.loads(db.q1("SELECT meta FROM tasks WHERE id=?", (read["id"],))["meta"])["lesson"] == r["lesson"]

"""Two edits to a plan of the user's own: units taken out of it (and put back), in the draft and after approval, and a
one-off study day on a day the plan has off. Both go through the normal planner: the days nobody has started are
planned again from the cursor."""
from __future__ import annotations

import asyncio
import json

from app import db, insights, onboarding, planlog, planner, profile, state, tracks
from conftest import set_now
from test_custom_plan import ANSWERS, H, _draft_and_approve, _fake_model, client  # noqa: F401 (fixture)


def _titles(ds: str, kind: str = "analysis") -> list[str]:
    return [t["title"] for t in db.q("SELECT t.title FROM tasks t JOIN blocks b ON b.id=t.block_id WHERE t.date=? "
                                     "AND b.kind=? ORDER BY b.ord, t.ord", (ds, kind))]


# ------------------------------------------------------------------ units out of the draft
def test_a_unit_taken_out_of_the_draft_is_never_planned(client, monkeypatch):
    _fake_model(monkeypatch)
    client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    asyncio.run(onboarding.run())
    before = client.get("/api/onboarding").json()["draft"]["plan"]
    r = client.put("/api/onboarding/unit", json={"track": "analysis", "unit": 1, "on": False}, headers=H)
    assert r.status_code == 200, r.text
    p = r.json()["draft"]["plan"]
    assert p["tracks"][0]["units"][1]["skip"] is True and p["tracks"][0]["units"][1]["title"] == "Sequences"
    # two sessions fewer: the projected end comes earlier or stays, never later
    assert p["end_date"] <= before["end_date"]
    assert p["track_ends"]["analysis"] < before["track_ends"]["analysis"]
    # a course keeps one unit at least
    assert client.put("/api/onboarding/unit", json={"track": "analysis", "unit": 0, "on": False}, headers=H).status_code == 200
    r = client.put("/api/onboarding/unit", json={"track": "analysis", "unit": 2, "on": False}, headers=H)
    assert r.status_code == 409 and "at least one unit" in r.json()["error"]
    client.put("/api/onboarding/unit", json={"track": "analysis", "unit": 0, "on": True}, headers=H)

    client.post("/api/onboarding/approve", json={"confirm": True}, headers=H)
    asyncio.run(planner.ensure_horizon())
    planned = [t["title"] for t in db.q("SELECT title FROM tasks")]
    assert "The real numbers · study" in planned and "Series · study" in planned
    assert not any(x.startswith("Sequences") for x in planned)
    assert "[-] 2. Sequences" in planlog.path().read_text()


def test_a_change_request_keeps_the_units_taken_out(client, monkeypatch):
    calls = _fake_model(monkeypatch)
    client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    asyncio.run(onboarding.run())
    client.put("/api/onboarding/unit", json={"track": "analysis", "unit": 1, "on": False}, headers=H)
    client.post("/api/onboarding/change", json={"change": "More algorithms"}, headers=H)
    asyncio.run(onboarding.run())
    p = client.get("/api/onboarding").json()["draft"]["plan"]
    assert p["tracks"][0]["units"][1].get("skip") is True
    assert '"skip": true' in calls[-1][1] and "taken out by the user" in calls[-1][1]


# ------------------------------------------------------------------ units out of the approved plan
def test_a_unit_taken_out_after_approval_moves_the_rest_up(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    assert _titles("2026-11-25")[:4] == ["The real numbers · study", "The real numbers · problems",
                                         "The real numbers · unit check", "Sequences · study (1/2)"]
    r = client.put("/api/plan/unit", json={"track": "analysis", "unit": 1, "on": False}, headers=H)
    assert r.status_code == 200 and r.json()["changed"] and "2026-11-25" in r.json()["replanned"]
    wed = _titles("2026-11-25")
    assert not any(x.startswith("Sequences") for x in wed) and "Series · study" in wed
    prog = client.get("/api/plan").json()["progress"][0]["units"]
    assert prog[1]["status"] == "removed" and prog[1]["removed"]
    assert "REMOVED by the user" in tracks.context()
    assert "Unit taken out of the plan: Real analysis · Sequences" in planlog.path().read_text()

    # put back: the days not started are planned again and Sequences comes back in its place
    client.put("/api/plan/unit", json={"track": "analysis", "unit": 1, "on": True}, headers=H)
    assert _titles("2026-11-25")[3] == "Sequences · study (1/2)"


def test_a_started_day_and_a_passed_unit_stay(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:30")
    first = db.q1("SELECT id FROM tasks WHERE date='2026-11-25' ORDER BY id LIMIT 1")["id"]
    client.post(f"/api/tasks/{first}/start", headers=H)
    wed = _titles("2026-11-25")
    r = client.put("/api/plan/unit", json={"track": "analysis", "unit": 1, "on": False}, headers=H)
    assert r.status_code == 200 and "2026-11-25" not in r.json()["replanned"]
    assert _titles("2026-11-25") == wed      # today's work stays as it was
    # a passed unit is done: it can't be taken out
    db.ex("INSERT INTO scores(date,kind,item,value,max,threshold,passed,ts) VALUES('2026-11-25','unit_quiz',?,5,5,4,1,'x')",
          ("Real analysis · The real numbers",))
    r = client.put("/api/plan/unit", json={"track": "analysis", "unit": 0, "on": False}, headers=H)
    assert r.status_code == 409 and "passed already" in r.json()["error"]


def test_unfinished_work_of_a_removed_unit_is_not_carried_over(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:30")
    first = db.q1("SELECT id FROM tasks WHERE date='2026-11-25' ORDER BY id LIMIT 1")["id"]
    client.post(f"/api/tasks/{first}/start", headers=H)      # Wednesday is started: it keeps Sequences 1/2
    client.put("/api/plan/unit", json={"track": "analysis", "unit": 1, "on": False}, headers=H)
    asyncio.run(planner.close_day("2026-11-25"))
    later = [t["title"] for t in db.q("SELECT title FROM tasks WHERE date>'2026-11-25'")]
    assert not any(x.startswith("Sequences") for x in later)
    assert any(x.startswith("The real numbers") for x in later)   # the rest of Wednesday still carries over


def test_a_unit_put_back_behind_the_cursor_comes_next_and_nothing_is_studied_twice():
    plan, _ = onboarding.normalize(__import__("test_custom_plan").model_draft(), onboarding.clean_answers(ANSWERS))
    plan["tracks"][0]["units"][1]["skip"] = True
    db.kv_set("plan", plan)
    db.ex("UPDATE profile SET preset='custom' WHERE id=1")
    profile.reload()
    db.kv_set("track_cursor", {"analysis": {"unit": 3, "session": 0}, "algo": {"unit": 0, "session": 0}})
    onboarding.set_plan_unit("analysis", 1, True)
    tracks.put_back(profile.track("analysis"), 1)
    assert tracks.cursor()["analysis"] == {"unit": 1, "session": 0, "done": [2]}
    from datetime import date
    titles = []
    for d in (date(2026, 11, 30), date(2026, 12, 2)):
        p = tracks.template_day(d)
        tracks.advance(d, p)
        titles += [t["title"] for k, ts in p.items() if k.startswith("analysis") for t in ts if t["kind"] == "read"]
    assert titles[:2] == ["Sequences · study (1/2)", "Sequences · study (2/2)"]
    assert not any(x.startswith("Series") for x in titles)        # done before: not studied again
    assert tracks.cursor()["analysis"]["unit"] == 3


# ------------------------------------------------------------------ a study day on a day off
def test_a_study_day_on_a_day_off_pulls_the_next_work_forward(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)                  # today Monday 23, the plan starts Tuesday 24
    tue = client.get("/api/day/2026-11-24").json()
    assert tue["status"] == "off" and tue["can_add"] == [0, 2, 4]
    r = client.post("/api/day/2026-11-24/extra", json={"like": 0}, headers=H)
    assert r.status_code == 200, r.text
    assert profile.study_weekdays() == {0, 2, 4}             # the weekly pattern is unchanged
    tue = client.get("/api/day/2026-11-24").json()
    assert tue["status"] == "locked" and tue["extra"] == {"like": 0, "removable": True}
    assert [b["kind"] for b in db.q("SELECT kind FROM blocks WHERE date='2026-11-24' ORDER BY ord")] == ["analysis", "break", "algo", "test"]
    # Tuesday takes what Wednesday had; Wednesday goes on from there
    assert _titles("2026-11-24")[0] == "The real numbers · study"
    assert not any(x.startswith("The real numbers") for x in _titles("2026-11-25"))
    assert client.post("/api/day/2026-11-24/extra", json={}, headers=H).status_code == 409    # a study day already
    assert client.post("/api/day/2026-11-22/extra", json={}, headers=H).status_code == 409    # over

    # taken back: Wednesday starts the plan again
    assert client.delete("/api/day/2026-11-24/extra", headers=H).status_code == 200
    assert client.get("/api/day/2026-11-24").json()["status"] == "off"
    assert _titles("2026-11-25")[0] == "The real numbers · study"


def test_a_study_day_added_today_runs_and_closes_like_any_other(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-28T09:00")                              # Saturday, off
    planner.close_overdue_now()
    r = client.post("/api/day/2026-11-28/extra", json={"like": 4}, headers=H)
    assert r.status_code == 200, r.text
    day = state.get_day("2026-11-28")
    assert day["status"] == "active" and any(b["kind"] == "test" for b in day["blocks"])
    task = next(t for b in day["blocks"] if b["kind"] == "algo" for t in b["tasks"])
    client.post(f"/api/tasks/{task['id']}/start", headers=H)
    set_now("2026-11-28T09:45")
    client.post(f"/api/tasks/{task['id']}/done", headers=H)
    assert not state.get_day("2026-11-28")["extra"]["removable"]
    assert client.delete("/api/day/2026-11-28/extra", headers=H).status_code == 409   # worked on: it stays
    assert insights._streaks({"2026-11-28": 45})[0] == 1    # the added day counts once studied
    asyncio.run(planner.close_day("2026-11-28"))
    assert db.q1("SELECT status FROM days WHERE date='2026-11-28'")["status"] == "closed"
    assert db.q1("SELECT 1 FROM days WHERE date='2026-11-30'")                 # the horizon goes on to Monday
    assert json.loads(db.q1("SELECT meta FROM tasks WHERE id=?", (task["id"],))["meta"])["track"] == "algo"


def test_an_extra_day_left_unstudied_does_not_break_the_streak(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    db.kv_set("extra_days", {"2026-11-28": 4})
    mins = {"2026-11-25": 60, "2026-11-27": 60, "2026-11-30": 60}
    set_now("2026-11-30T20:00")
    assert insights._streaks(mins)[0] == 3

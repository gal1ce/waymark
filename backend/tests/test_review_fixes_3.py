"""Fixes from the third user test: a question that names a function it never shows is caught before the test starts,
and one that slips through can be marked broken afterwards. Nothing here goes to the network."""
from __future__ import annotations

import asyncio
import json

from app import db, llm, tests_eod
from test_custom_plan import H, _draft_and_approve, client  # noqa: F401
from test_review_fixes_2 import _q


def test_a_question_missing_its_function_is_replaced_before_the_test(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    tid = tests_eod.create_practice({"topics": "Limits", "topic_list": [], "count": 3, "level": "easy"})
    broken = {**_q(3), "prompt": "What value of $k$ makes the piecewise function continuous at $x = 2$?"}
    asks = []

    async def live(system, prompt, schema, on, effort="medium", max_tokens=16000):
        asks.append(prompt)
        return {"questions": [_q(1), _q(2), broken]}

    async def structured(system, prompt, schema, effort="medium", max_tokens=16000):
        if "missing" in schema["properties"]:                          # the completeness check
            return {"missing": [{"id": q, "why": "no function given"} for q in ("q3",) if "piecewise" in prompt]}
        asks.append(prompt)                                            # the replacement
        return {"questions": [{**_q(9), "prompt": "What is $\\lim_{x \\to 1} 3x$?"}]}
    monkeypatch.setattr(llm, "structured_live", live)
    monkeypatch.setattr(llm, "structured", structured)
    asyncio.run(tests_eod.fill(tid))
    assert "answerable from exactly what is shown" in asks[0]
    assert "rejected because" in asks[1] and "piecewise" in asks[1]
    qs = json.loads(db.q1("SELECT questions FROM tests WHERE id=?", (tid,))["questions"])
    assert [q["id"] for q in qs] == ["q1", "q2", "q3"] and "piecewise" not in json.dumps(qs) and "lim" in qs[2]["prompt"]


def test_without_a_model_check_the_cheap_look_still_drops_it():
    assert tests_eod._maybe_incomplete({"prompt": "What value of $k$ makes the piecewise function continuous at $x = 2$?"})
    assert not tests_eod._maybe_incomplete({"prompt": "What is the limit of the function $f(x) = 3x^2 - 1$ at $x = 2$?"})
    assert not tests_eod._maybe_incomplete({"prompt": "What is the value of this limit?", "math": "\\lim_{x \\to 3} x"})
    assert not tests_eod._maybe_incomplete({"prompt": "For a function $f(x)$ to be continuous at $x = c$, what must hold?"})


def test_a_broken_question_leaves_the_score_and_closes_its_sticking_point(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    task = db.q1("SELECT id FROM tasks WHERE kind='test' ORDER BY date LIMIT 1")
    tid = db.ex("INSERT INTO tests(date,kind,task_id,status,source,created_at,time_limit_min,questions,started_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)", ("2026-11-23", "eod", task["id"], "in_progress", "agent", db.ts(), 20,
                                               json.dumps([_q(1), _q(2), _q(3)]), db.ts()))
    asyncio.run(tests_eod.submit(tid, {"q1": "1", "q2": "1", "q3": "0"}))
    assert db.q1("SELECT value, max FROM scores WHERE task_id=?", (task["id"],)) == {"value": 2, "max": 3}
    assert client.post(f"/api/tests/{tid}/questions/q1/void", json={}, headers=H).status_code == 200   # a right one: allowed, harmless
    r = client.post(f"/api/tests/{tid}/questions/q3/void", json={"why": "no function shown"}, headers=H).json()
    res = {x["id"]: x for x in r["results"]}
    assert res["q3"]["void"] and res["q3"]["void_why"] == "no function shown" and (r["score"], r["max"]) == (1, 1)
    assert db.q1("SELECT value, max FROM scores WHERE task_id=?", (task["id"],)) == {"value": 1, "max": 1}
    assert not db.q1("SELECT 1 FROM stuck WHERE task_id=? AND resolved=0", (task["id"],))
    assert client.post(f"/api/tests/{tid}/questions/q2/void", json={}, headers=H).status_code == 409   # the last one stays
    assert db.q1("SELECT 1 FROM events WHERE type='question_voided'")


def test_a_task_keeps_its_units_source_whatever_the_day_model_writes():
    from app import tracks
    tr = {"key": "calculus", "label": "Calculus", "units": [
        {"title": "Limits", "resources": [{"label": "Paul's Notes: Limits", "href": "https://tutorial.math.lamar.edu/x"}]}]}
    made_up = {"title": "Limits · study", "kind": "read", "est_min": 45, "detail": "", "learning": True,
               "resources": [{"label": "Calculus Chapter 1", "href": ""}, {"label": "Extra", "href": "https://example.org/a"}]}
    res = tracks._to_internal({**made_up, "unit": 0}, tr)["resources"]
    assert [r["label"] for r in res] == ["Paul's Notes: Limits", "Extra"]
    no_unit = tracks._to_internal(made_up, tr, here=0)["resources"]       # the model left out the unit number
    assert no_unit[0]["href"] == "https://tutorial.math.lamar.edu/x"
    assert [r["label"] for r in tracks._to_internal(made_up, {**tr, "units": [{"title": "L"}]}, here=0)["resources"]] \
        == ["Calculus Chapter 1", "Extra"]                               # no planned source: the model's stay


def test_an_undated_plan_gets_a_roadmap_and_summary_that_match_its_schedule(client, monkeypatch):
    from app import onboarding
    from test_custom_plan import ANSWERS, _fake_model, model_draft
    draft = model_draft(summary="A daily plan. It establishes a three-month roadmap across all subjects.", deadline="",
                        roadmap=[{"start": "2026-11", "end": "2027-02", "items": ["Everything"]}])
    _fake_model(monkeypatch, draft)
    client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, "deadline": ""}}, headers=H)
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    p = st["draft"]["plan"]
    assert p["deadline"] == "" and p["end_date"]
    assert all(r["end"] <= p["end_date"][:7] for r in p["roadmap"])        # nothing past the real end
    assert "three-month" not in p["summary"] and "A daily plan." in p["summary"]
    assert any("three-month" in n for n in st["draft"]["notes"]) and any("follows the schedule" in n for n in st["draft"]["notes"])


def test_explain_now_opens_explanations_early_and_tells_the_coach(client, monkeypatch):
    from app import agent, state
    from conftest import set_now
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:05")
    task = db.q1("SELECT id FROM tasks WHERE date='2026-11-25' AND learning=1 ORDER BY ord LIMIT 1")
    client.post(f"/api/tasks/{task['id']}/start", headers=H)
    status, _ = agent._status_block(state.current_task())
    assert "explanations open: NO" in status
    r = client.post(f"/api/tasks/{task['id']}/explain-now", headers=H).json()
    assert r["explain_early"] == 0
    status, _ = agent._status_block(state.current_task())
    assert "explanations open: YES" in status and "Explain now" in status and "never" in status
    assert db.q1("SELECT 1 FROM events WHERE type='explain_now'")
    assert "No active task" in agent._status_block(None)[0]


# ------------------------------------------------------------------ exam dates per course
def _trs(a_exam="", b_exam="", a_sessions=2, b_sessions=2):
    return [{"key": "a", "label": "Calculus", "deadline": a_exam, "units": [{"title": "Limits", "sessions": a_sessions}]},
            {"key": "b", "label": "Algebra", "deadline": b_exam, "units": [{"title": "Matrices", "sessions": b_sessions}]}]


def test_no_exam_dates_change_nothing():
    from datetime import date as D
    from app import tracks
    blocks = [{"kind": "a", "title": "Calculus"}, {"kind": "b", "title": "Algebra"}, {"kind": "test", "title": "test"}]
    assert tracks.remap(blocks, D(2026, 12, 1), _trs(), {"a": 1, "b": 1}) == blocks


def test_a_course_whose_exam_is_over_gives_its_blocks_to_the_next_exam():
    from datetime import date as D
    from app import tracks
    blocks = [{"kind": "a", "title": "Calculus"}, {"kind": "test", "title": "test"}]
    out = tracks.remap(blocks, D(2026, 12, 11), _trs("2026-12-10", "2027-01-20"), {"a": 0, "b": 3})
    assert out[0] == {"kind": "b", "title": "Algebra", "moved_from": "a", "moved_why": "over"} and out[1]["kind"] == "test"


def test_the_week_before_an_exam_takes_blocks_from_a_far_one_while_it_is_behind():
    from datetime import date as D
    from app import tracks
    blocks = [{"kind": "b", "title": "Algebra"}]
    trs = _trs("2026-12-10", "2027-02-01")
    assert tracks.remap(blocks, D(2026, 12, 5), trs, {"a": 2, "b": 3})[0]["kind"] == "a"     # 5 days to go, behind
    assert tracks.remap(blocks, D(2026, 12, 5), trs, {"a": 0, "b": 3})[0]["kind"] == "b"     # on time: no crunch
    assert tracks.remap(blocks, D(2026, 11, 25), trs, {"a": 2, "b": 3})[0]["kind"] == "b"    # still 15 days away
    near = _trs("2026-12-10", "2026-12-20")                                                    # both exams close: no taking
    assert tracks.remap(blocks, D(2026, 12, 5), near, {"a": 2, "b": 3})[0]["kind"] == "b"


def test_the_projection_follows_the_exam_rules():
    from datetime import date as D
    from app import tracks
    week = [[{"kind": "a"}], [{"kind": "b"}], [], [], [], [], []]            # Mon: a, Tue: b
    start = D(2026, 11, 30)
    # no exam dates: a's 4 sessions take four Mondays
    assert tracks.finish(week, _trs(a_sessions=4), start) == D(2026, 12, 21)
    # exam on 15 Dec: Mon 30 Nov, (Tue 1 Dec is b's: 14 days to go), Mon 7, Tue 8 (taken from b), Mon 14
    ends = {label: d for d, label, _t in tracks.unit_ends(week, _trs("2026-12-15", "2027-03-01", a_sessions=4), start)}
    assert ends["Calculus"] == D(2026, 12, 14)


def test_the_draft_checks_each_course_against_its_own_exam(client, monkeypatch):
    from app import onboarding
    from test_custom_plan import ANSWERS, _fake_model, model_draft
    base = model_draft()
    many = [{"title": f"U{i}", "objective": "x", "practice": "y", "sessions": 3, "resources": []} for i in range(8)]
    base["tracks"][0] |= {"deadline": "2026-12-01", "units": many}           # far too much for 1 Dec
    base["tracks"][1] |= {"deadline": "2027-06-30"}
    _fake_model(monkeypatch, base)
    client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, "deadline": ""}}, headers=H)
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    p = st["draft"]["plan"]
    assert [t["deadline"] for t in p["tracks"]] == ["2026-12-01", "2027-06-30"] and p["deadline"] == "2027-06-30"
    label = p["tracks"][0]["label"]
    assert any(n.startswith(f"{label}: at this schedule") and "after its exam on 2026-12-01" in n for n in st["draft"]["notes"])
    assert "Exams: " in p["coach"]["context"] and "on 2026-12-01" in p["coach"]["context"]


def test_exam_dates_can_be_changed_on_the_approved_plan(client, monkeypatch):
    from app import profile, tracks
    _draft_and_approve(client, monkeypatch)
    key = profile.tracks()[0]["key"]
    assert client.put("/api/plan/exams", json={"dates": {"nope": "2027-01-10"}}, headers=H).status_code == 409
    assert client.put("/api/plan/exams", json={"dates": {key: "2026-01-10"}}, headers=H).status_code == 409
    r = client.put("/api/plan/exams", json={"dates": {key: "2027-01-10"}}, headers=H).json()
    assert r["changed"] and profile.tracks()[0]["deadline"] == "2027-01-10"
    assert profile.active()["coach"]["context"].count(" Exams: ") == 1
    assert "2027-01-10" in tracks.context()
    client.put("/api/plan/exams", json={"dates": {key: "2027-01-12"}}, headers=H)
    assert profile.active()["coach"]["context"].count(" Exams: ") == 1 and "2027-01-12" in profile.active()["coach"]["context"]
    assert client.put("/api/plan/exams", json={"dates": {key: ""}}, headers=H).json()["changed"]
    assert " Exams: " not in profile.active()["coach"]["context"]


def test_a_moved_block_says_why_on_its_tasks(client, monkeypatch):
    from datetime import date as D
    from app import profile, tracks
    _draft_and_approve(client, monkeypatch)
    trs = profile.tracks()
    first, second = trs[0], trs[1]
    plan = json.loads(json.dumps(db.kv_get("plan", {})))
    plan["tracks"][0]["deadline"] = "2026-11-24"                # over before the first study day
    plan["tracks"][1]["deadline"] = "2027-03-01"
    db.kv_set("plan", plan)
    profile.reload()
    d = D(2026, 12, 7)                                           # not planned yet (a stored day keeps its blocks)
    assert not db.q1("SELECT 1 FROM blocks WHERE date='2026-12-07'")
    moved = [b for b in tracks.day_blocks(d) if b.get("moved_from")]
    assert moved and all(b["kind"] == second["key"] and b["moved_from"] == first["key"] for b in moved)
    metas = [t["meta"] for ts in tracks.template_day(d).values() for t in ts if t["meta"].get("moved_from")]
    assert metas and metas[0]["moved_from"] == first["label"] and metas[0]["moved_why"] == "over"

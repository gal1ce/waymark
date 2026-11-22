"""Fixes from the second user test: a problem task gets a practice set in the app, and its wrong answers come back as
sticking points. Nothing here goes to the network."""
from __future__ import annotations

import asyncio
import json

from app import db, llm, main, tests_eod
from conftest import set_now
from test_custom_plan import H, _draft_and_approve, client  # noqa: F401


def _q(i):
    return {"id": f"q{i}", "type": "short", "topic": "Limits", "prompt": f"Question {i}?", "math": "", "code": "", "choices": [],
            "answer": "1", "accept": [], "answer_format": "", "explanation": ""}


def test_a_problem_task_gets_a_practice_set_that_feeds_sticking_points(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:00")
    monkeypatch.setattr(main, "spawn", lambda coro: coro.close())
    task = db.q1("SELECT * FROM tasks WHERE date='2026-11-25' AND kind='practice' ORDER BY id LIMIT 1")
    assert "Practice set" in task["detail"]
    read = db.q1("SELECT id FROM tasks WHERE date='2026-11-25' AND kind='read' LIMIT 1")
    assert client.post(f"/api/tasks/{read['id']}/practice", headers=H).status_code == 409
    later = db.q1("SELECT id FROM tasks WHERE date>'2026-11-25' AND kind='practice' LIMIT 1")
    assert client.post(f"/api/tasks/{later['id']}/practice", headers=H).status_code == 409

    r = client.post(f"/api/tasks/{task['id']}/practice", headers=H).json()
    assert r["existing"] is False
    assert client.post(f"/api/tasks/{task['id']}/practice", headers=H).json() == {"id": r["id"], "existing": True}
    seen = []

    async def live(system, prompt, schema, on, effort="medium", max_tokens=16000):
        seen.append(prompt)
        return {"questions": [_q(i) for i in range(1, 7)]}
    monkeypatch.setattr(llm, "structured_live", live)
    asyncio.run(tests_eod.fill(r["id"]))
    unit = json.loads(task["meta"])
    assert seen and "replace a study-plan task" in seen[0] and f"Task: {task['title']}" in seen[0]
    assert isinstance(unit["unit"], int)

    view = client.get(f"/api/tests/{r['id']}").json()
    assert view["practice"]["from_task"] is True and "sticking points" in view["threshold"]
    tests_eod.start(r["id"])
    asyncio.run(tests_eod.submit(r["id"], {"q1": "1", "q2": "1", "q3": "0"}))
    stuck = db.q("SELECT * FROM stuck WHERE task_id=? AND resolved=0", (task["id"],))
    assert len(stuck) == 4 and all(s["summary"] == "Practice set · Limits" for s in stuck)
    assert not db.q1("SELECT 1 FROM scores WHERE kind='practice'")          # still not scored
    # a finished set doesn't block a new one
    assert client.post(f"/api/tasks/{task['id']}/practice", headers=H).json()["existing"] is False


def test_a_coach_made_practice_test_still_makes_no_sticking_points(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    tid = tests_eod.create_practice({"topics": "Limits", "topic_list": [], "count": 6, "level": "easy"})
    db.ex("UPDATE tests SET status='in_progress', started_at=?, questions=? WHERE id=?",
          (db.ts(), json.dumps([_q(1)]), tid))
    asyncio.run(tests_eod.submit(tid, {"q1": "0"}))
    assert not db.q1("SELECT 1 FROM stuck WHERE summary LIKE 'Practice set%'")


def test_progress_breaks_tests_down_by_topic_weakest_first(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)

    def done(day, rows):
        qs = [{**_q(i), "topic": t} for i, (t, _) in enumerate(rows, 1)]
        res = [{"id": f"q{i}", "correct": ok, "topic": t, "given": "0", "answer": "1"} for i, (t, ok) in enumerate(rows, 1)]
        db.ex("INSERT INTO tests(date,kind,status,source,created_at,time_limit_min,questions,results,score,max) "
              "VALUES(?,?,?,?,?,?,?,?,?,?)", (day, "eod", "submitted", "agent", db.ts(), 20, json.dumps(qs), json.dumps(res),
                                              sum(ok for _, ok in rows), len(rows)))
    done("2026-11-23", [("Limits", False), ("Limits", False), ("Sorting", True)])
    done("2026-11-25", [("Limits", True), ("limits ", False), ("Sorting", True)])
    rows = client.get("/api/progress").json()["topics"]
    assert [r["topic"] for r in rows] == ["Limits", "Sorting"]
    lim = rows[0]
    assert (lim["right"], lim["total"], lim["trend"]) == (1, 4, "up")
    assert [a["right"] for a in lim["attempts"]] == [0, 1] and lim["miss"]["date"] == "2026-11-25"


def test_a_notebook_page_names_its_topic_and_shows_up_there(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    page = client.post("/api/notes", json={"title": "Limit map", "kind": "canvas"}, headers=H).json()
    assert page["topic"] == ""
    assert client.put(f"/api/notes/{page['id']}", json={"topic": "  Limits  "}, headers=H).json()["topic"] == "Limits"
    about = client.get("/api/notes/about", params={"topic": "Limits & continuity"}).json()["pages"]
    assert [p["id"] for p in about] == [page["id"]]
    assert client.get("/api/notes/about", params={"topic": "Sorting"}).json()["pages"] == []
    choices = client.get("/api/notes/about").json()["choices"]
    assert "The real numbers" in choices and "Limits" in choices          # the plan's units and topics in use
    db.ex("INSERT INTO tests(date,kind,status,source,created_at,time_limit_min,questions,results,score,max) "
          "VALUES('2026-11-23','eod','submitted','agent',?,20,?,?,0,1)",
          (db.ts(), json.dumps([_q(1)]), json.dumps([{"id": "q1", "correct": False, "topic": "Limits", "given": "", "answer": "1"}])))
    assert client.get("/api/progress").json()["topics"][0]["notes"] == [{"id": page["id"], "title": "Limit map"}]
